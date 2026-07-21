"""Booru Tagger V3 — inference worker.

Talks NDJSON over stdio with the Electron main process. No ports, no Docker.

Requests (one JSON object per line on stdin):
    {"id": 1, "cmd": "hello"}
    {"id": 2, "cmd": "init",  "model": "both", "threshold": 0.1, "parallel": 4}
    {"id": 3, "cmd": "tag",   "path": "C:/imgs/a.jpg", "jsonOut": "C:/imgs/Json/a.json"}
    {"id": 9, "cmd": "shutdown"}

Responses (one JSON object per line on stdout):
    {"id": 1, "ok": true, "providers": [...], "provider": "DmlExecutionProvider"}
    {"id": 2, "ok": true, "model": "both"}
    {"id": 3, "ok": true, "path": "...", "tagCount": 42, "topTags": ["1girl", ...]}
    {"id": 3, "ok": false, "path": "...", "error": "..."}

The worker writes each image's tag JSON file itself (autotagger-compatible
format) so tag dicts never cross the pipe.

MODELS registry: add a new model = add one entry here.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

# Quiet the harmless Windows symlink warning from huggingface_hub.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# ---------------------------------------------------------------------------
# Provider setup: prefer DirectML on Windows (no CUDA toolkit needed),
# CUDA elsewhere/if present, CPU as last resort. Honors ONNX_MODE if set.
# ---------------------------------------------------------------------------
def _add_nvidia_dll_dirs() -> None:
    """Make pip-installed CUDA/cuDNN DLLs findable on Windows.

    cuDNN 9 lazy-loads sub-libraries (cudnn_engines_tensor_ir64_9.dll etc.)
    at inference time via the standard Windows DLL search — which does NOT
    include the venv's nvidia package dirs. Without this, sessions create
    fine but fail mid-run with CUDNN_STATUS_SUBLIBRARY_LOADING_FAILED.
    """
    if os.name != "nt":
        return
    import glob
    import site

    roots = list(site.getsitepackages())
    try:
        roots.append(site.getusersitepackages())
    except Exception:
        pass
    for root in roots:
        for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
            except OSError:
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()

import onnxruntime

# With onnxruntime-gpu[cuda,cudnn], the CUDA/cuDNN DLLs live inside pip
# packages — preload_dlls() (ORT 1.21+) makes them findable on Windows.
if hasattr(onnxruntime, "preload_dlls"):
    try:
        onnxruntime.preload_dlls()
    except Exception:
        pass

_AVAILABLE = onnxruntime.get_available_providers()
if not os.environ.get("ONNX_MODE"):
    if "CUDAExecutionProvider" in _AVAILABLE:
        os.environ["ONNX_MODE"] = "gpu"  # fastest, thread-safe, PixAI-compatible
    elif "DmlExecutionProvider" in _AVAILABLE:
        os.environ["ONNX_MODE"] = "dml"
    else:
        os.environ["ONNX_MODE"] = "cpu"

from imgutils.generic import multilabel_timm_predict  # noqa: E402
from imgutils.tagging import get_pixai_tags, get_wd14_tags  # noqa: E402

_RATING_MAP = {
    "general": "rating:g",
    "sensitive": "rating:s",
    "questionable": "rating:q",
    "explicit": "rating:e",
}

# DirectML is NOT thread-safe for concurrent InferenceSession.Run() calls —
# parallel workers on a DML session cause a native access violation
# (0xC0000005). Serialize GPU inference; the GPU pipelines one batch at a
# time anyway, and image decode still runs in parallel threads. CPU and CUDA
# sessions are thread-safe and stay fully parallel.
from contextlib import nullcontext  # noqa: E402

_GPU_LOCK = threading.Lock()


def _gpu_guard():
    return _GPU_LOCK if os.environ.get("ONNX_MODE") == "dml" else nullcontext()

ANIMETIMM_REPO = os.environ.get(
    "ANIMETIMM_REPO", "animetimm/mobilenetv3_large_150d.dbv4-full"
)


def _tag_wd_eva02(path: str, threshold: float) -> dict[str, float]:
    with _gpu_guard():
        rating, general, character = get_wd14_tags(
            path,
            model_name="EVA02_Large",
            general_threshold=threshold,
            character_threshold=threshold,
            no_underline=False,
            drop_overlap=False,
        )
    tags: dict[str, float] = {}
    tags.update({k: float(v) for k, v in general.items()})
    tags.update({k: float(v) for k, v in character.items()})
    for name, score in rating.items():
        if score >= threshold:
            tags[_RATING_MAP.get(name, f"rating:{name}")] = float(score)
    return tags


def _tag_pixai(path: str, threshold: float) -> dict[str, float]:
    # No GPU guard: the PixAI ONNX export is incompatible with DML, so its
    # session always falls back to CPU, which is thread-safe.
    general, character = get_pixai_tags(
        path, model_name="v0.9", thresholds=threshold, fmt=("general", "character")
    )
    tags: dict[str, float] = {}
    tags.update({k: float(v) for k, v in general.items()})
    tags.update({k: float(v) for k, v in character.items()})
    return tags


def _tag_animetimm(path: str, threshold: float) -> dict[str, float]:
    # animetimm repos are gated on HF — requires an account that accepted the
    # repo terms and a read token (set via the app's HF token field).
    with _gpu_guard():
        raw = multilabel_timm_predict(
            path, repo_id=ANIMETIMM_REPO, thresholds=threshold, fmt="tag",
            hf_token=os.environ.get("HF_TOKEN"),
        )
    return {_RATING_MAP.get(k, k): float(v) for k, v in raw.items()}


def _tag_both(path: str, threshold: float) -> dict[str, float]:
    merged = _tag_wd_eva02(path, threshold)
    for tag, score in _tag_pixai(path, threshold).items():
        if tag not in merged or score > merged[tag]:
            merged[tag] = score
    return merged


MODELS = {
    "pixai": _tag_pixai,
    "wd-eva02": _tag_wd_eva02,
    "animetimm": _tag_animetimm,
    "both": _tag_both,
}

# ---------------------------------------------------------------------------
# Worker state & protocol
# ---------------------------------------------------------------------------
_state = {"model": "both", "threshold": 0.1}
_pool: ThreadPoolExecutor | None = None
_write_lock = threading.Lock()


def _send(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _handle_tag(req: dict) -> None:
    path = req.get("path", "")
    json_out = req.get("jsonOut", "")
    try:
        fn = MODELS[_state["model"]]
        tags = fn(path, _state["threshold"])
        tags = dict(sorted(tags.items(), key=lambda kv: kv[1], reverse=True))
        payload = [{"filename": os.path.basename(path), "tags": tags}]
        os.makedirs(os.path.dirname(json_out), exist_ok=True)
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        _send({
            "id": req["id"],
            "ok": True,
            "path": path,
            "tagCount": len(tags),
            "topTags": list(tags.keys())[:5],
        })
    except Exception as exc:
        _send({
            "id": req["id"],
            "ok": False,
            "path": path,
            "error": f"{type(exc).__name__}: {exc}",
        })


def _handle_warmup(req: dict) -> None:
    """Load the current model(s) by tagging a tiny generated image."""
    import tempfile

    from PIL import Image

    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            Image.new("RGB", (64, 64), "white").save(f.name)
            tmp = f.name
        try:
            models = (
                ("pixai", "wd-eva02")
                if _state["model"] == "both"
                else (_state["model"],)
            )
            for name in models:
                MODELS[name](tmp, 0.99)
        finally:
            os.unlink(tmp)
        _send({"id": req["id"], "ok": True, "warmed": True})
    except Exception as exc:
        _send({"id": req["id"], "ok": False, "error": f"{type(exc).__name__}: {exc}"})


def main() -> None:
    global _pool
    _pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tag")

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            req = json.loads(raw_line)
        except json.JSONDecodeError:
            _send({"id": None, "ok": False, "error": "bad json"})
            continue

        cmd = req.get("cmd")
        try:
            if cmd == "hello":
                _send({
                    "id": req["id"],
                    "ok": True,
                    "providers": _AVAILABLE,
                    "provider": os.environ.get("ONNX_MODE"),
                    "models": list(MODELS),
                    "animetimmRepo": ANIMETIMM_REPO,
                })
            elif cmd == "init":
                model = req.get("model", "both")
                if model not in MODELS:
                    _send({"id": req["id"], "ok": False,
                           "error": f"unknown model {model!r}"})
                    continue
                _state["model"] = model
                _state["threshold"] = float(req.get("threshold", 0.1))
                token = (req.get("hfToken") or "").strip()
                if token:
                    os.environ["HF_TOKEN"] = token
                    os.environ["HUGGING_FACE_HUB_TOKEN"] = token
                parallel = max(1, min(int(req.get("parallel", 4)), 16))
                _pool.shutdown(wait=True)
                _pool = ThreadPoolExecutor(
                    max_workers=parallel, thread_name_prefix="tag"
                )
                _send({"id": req["id"], "ok": True, "model": model,
                       "threshold": _state["threshold"], "parallel": parallel})
            elif cmd == "warmup":
                _pool.submit(_handle_warmup, req)
            elif cmd == "tag":
                _pool.submit(_handle_tag, req)
            elif cmd == "shutdown":
                _send({"id": req["id"], "ok": True})
                break
            else:
                _send({"id": req.get("id"), "ok": False,
                       "error": f"unknown cmd {cmd!r}"})
        except Exception as exc:
            _send({"id": req.get("id"), "ok": False,
                   "error": f"{type(exc).__name__}: {exc}",
                   "trace": traceback.format_exc(limit=3)})

    _pool.shutdown(wait=True)


if __name__ == "__main__":
    main()
