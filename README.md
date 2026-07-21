# Booru Tagger V3

Ground-up rebuild of the Booru Processor. No Docker. One app, one integrated
GPU inference worker, modern UI.

## What changed vs V2

| | V2 | V3 |
|---|---|---|
| Inference | Up to 10 Docker containers, CPU-only ResNet-152 (2022) | 1 Python worker, GPU via DirectML, modern models |
| Models | autotagger only (~5.5k tags) | PixAI v0.9, WD EVA02 v3, AnimeTimm, or merged (~10–13.5k tags) |
| Transport | HTTP file uploads to localhost | File paths over stdio — no ports, no uploads |
| Reliability code | Health checks, retries, container recovery (~half the codebase) | Not needed |
| Output | `Json/` folder + `processed_log.json` | **Identical** — Eagle pipeline untouched |

## Run it

```bash
npm install
npm start
```

## Build the .exe

```bash
npm run build
```

Output lands in `dist/`: an NSIS installer (`Booru Tagger Setup 3.0.0.exe`)
plus an unpacked build in `dist/win-unpacked/` you can run directly. The
installed app keeps its Python venv and settings in
`%APPDATA%\booru-tagger-v3`, so updates never touch your environment.
Note: the target machine still needs Python 3.9+ installed for first-run setup.

First launch only: the app finds your Python (3.9+ required, from python.org),
creates a private `.venv`, and installs the inference libraries (~2 min).
First tagging run additionally downloads model weights (~2.5 GB for Merged).
After that, everything is instant and fully offline except new model downloads.

## Using it

1. **Add folders** — subfolders optional, `Json/` dirs are ignored automatically.
2. **Pick a model** — Merged is the best default. PixAI for newest characters,
   WD EVA02 for precision + ratings, AnimeTimm for speed.
3. **Which images** — All / New only (skips logged successes) / Missing JSON /
   **Update tagged** (re-tags only images that already have a JSON, replacing
   their old tags with the selected model's — ideal when you switch models or
   a better one comes along).
4. **Start.** Pause/cancel any time; progress, rate, and ETA are live.

Output per image: `<folder>/Json/<name>.json` in autotagger format
(`[{"filename": ..., "tags": {tag: confidence}}]`), plus NDJSON entries in
`<folder>/Json/processed_log.json` — both byte-compatible with V2.

## Parallel workers

The slider controls how many images are in flight at once (decode + preprocess
run in parallel threads; the GPU pipelines the inference). 4 is a good default;
raise it if your GPU isn't saturated, lower it to keep the PC responsive.

## Adding / changing models

Everything lives in `worker/worker.py`:

- Add a function that returns `{tag: score}` and register it in the `MODELS`
  dict — it appears in the app after adding a card in `renderer/index.html`
  (`.model-opt` button with `data-model="<key>"`).
- Swap the AnimeTimm variant with the `ANIMETIMM_REPO` env var (any ungated
  repo on https://huggingface.co/animetimm that ships `model.onnx`).

## GPU notes

- **NVIDIA machines get CUDA automatically**: setup detects the GPU
  (`nvidia-smi`) and installs the CUDA runtime straight from pip — no CUDA
  Toolkit needed. CUDA is the fastest backend, is thread-safe (full parallel
  inference), and runs **all** models on GPU including PixAI.
- Non-NVIDIA Windows machines use **DirectML** (AMD/Intel, zero installs).
  Under DML, PixAI falls back to CPU (its ONNX graph is DML-incompatible —
  the "EP Error ... Falling back" notice is handled, results are correct) and
  GPU inference is serialized for thread safety.
- Force a backend with the `ONNX_MODE` env var (`gpu` = CUDA, `dml`, `cpu`).
- The worker pill in the header shows which provider is active.

## Gated models (AnimeTimm)

The animetimm org gates its Hugging Face repos. One-time setup:

1. Create a free account at https://huggingface.co
2. Open the model page (e.g. `animetimm/mobilenetv3_large_150d.dbv4-full`)
   and accept its terms
3. Settings → Access Tokens → create a **Read** token
4. Paste it into the app's "HF token" field

The token is stored locally and only sent to Hugging Face. PixAI and WD EVA02
are ungated and need no token.

## Files

```
main.js               Electron main — orchestration only
preload.js            IPC bridge (contextIsolation on)
lib/pythonEnv.js      First-run venv setup
lib/worker.js         Python worker process + stdio protocol
lib/scanner.js        Folder scan, modes, processed_log (V2-compatible)
worker/worker.py      Inference worker + MODELS registry
renderer/             UI (vanilla HTML/CSS/JS, dark theme)
```
