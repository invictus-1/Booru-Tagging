# Changelog

## Booru Suite — 4.0.0

Booru Tagger V3 and the Eagle Toolkit merged into one app, plus the new Eagle
Sync. (Continues the repo's numbering after Booru Tagger 3.0.0.)

### Highlights
- Four tabs: **Tagger**, **Renamer**, **Tag Merger**, **Eagle Sync**. Each
  tool's screen and behaviour is unchanged.
- Tagger and Eagle tools run independently, so you can tag while a sync runs.
  A pulsing dot marks tabs with a running job.
- First launch copies Eagle Sync history (hash database, import ledger, run
  journals) from the old Eagle Toolkit, and reuses the old Tagger's Python
  environment in place, so there's no CUDA reinstall. Old apps are not modified.
- Each Eagle tool keeps its own last-run numbers when you switch tabs.
- One data folder (`%APPDATA%\booru-suite`) for both `npm start` and the installed app.
- The "close Eagle first" tip now appears only on Tag Merger (Eagle Sync needs
  Eagle open).

### Hardening (from a full code review before release)
- Eagle Sync: a file that couldn't be read during the scan (locked, cloud-only,
  still downloading) is no longer imported blind. It's listed as "couldn't
  verify" and left out until a later scan can check it.
- Eagle Sync: an import only counts as "deleted from Eagle" once it was
  verified in Eagle. Imports Eagle never finished writing (closed or crashed
  mid-import) come back as new instead of being skipped forever.
- Eagle Sync: Eagle's live folder list now wins over its library snapshot, so
  a folder renamed or moved since Eagle opened no longer gets duplicated.
- Eagle Sync: imports are recorded (ledger, undo journal, manifest) the moment
  Eagle accepts them. Closing the app mid-import finishes the current batch first.
- Eagle Sync: free-space check happens before anything in Eagle is changed.
- Eagle Sync: Undo only "forgets" items it actually moved to the trash. Verify
  skips undone runs and doesn't count trashed items as verified.
- Eagle Sync: overlapping source folders are walked once; Eagle folder names
  containing "/" can't be mixed up with nested folders.
- Tagger: tag files are written atomically, so Sync can never read a half-written one.
- Tag Merger: only item metadata (`<id>.info/metadata.json`) is ever considered;
  the library-level metadata.json (folder tree) is skipped outright instead of
  being reported as a failed item.

## Eagle Toolkit — 1.1.0

### Added
- **Eagle Sync tab** — one-way PC → Eagle mirror that never duplicates.
  Scans Eagle and your PC folders, matches files by content (size pre-filter
  + SHA-256, or a fast head/tail fingerprint), and imports only what's
  missing into the Eagle folder with the same name. Missing Eagle folders are
  created after a confirmation prompt.
- Persistent hash database (first scan builds it; later scans are near-instant)
  and an import ledger, so files deleted from Eagle aren't re-imported.
- Files already in Eagle under a different folder can be filed into the
  matching folder without copying.
- Booru tags from the tagger's Json files are attached on import.
- **Safety copy**: new files are copied (and hash-checked) into a dated
  `Eagle Sync Backup` folder and Eagle imports from the copy, so originals
  are never handed to Eagle. Per-run `manifest.csv`.
- **Post-import verification**: every imported item's file in the Eagle
  library is SHA-256-compared to the original; the log says when the backup
  is safe to delete.
- Safety checks: sources verified untouched after the first batch; import
  refuses to run if Eagle switched libraries since the scan.
- Works with Eagle's V2 API (4.0 Build 21+) and falls back to V1.

## Booru Tagger V3 — 3.0.0

Complete rebuild. Replaces Booru Processor 2.0.

### Changed
- **Docker removed entirely.** The up-to-10 CPU-only containers are replaced
  by a single integrated GPU inference worker (CUDA on NVIDIA, auto-installed
  from pip — no CUDA Toolkit; DirectML on AMD/Intel; CPU fallback).
  Throughput is a multiple of v2's at a fraction of the system load.
- **Models modernized.** The 2022 Danbooru autotagger (~5.5k tags) is replaced
  by switchable current models: PixAI v0.9 (Jan 2025 data, ~13.5k tags),
  WD EVA02 v3 (~10k tags, ratings), AnimeTimm (2025 data), and a Merged mode
  (PixAI + WD union — default). Adding future models is a small registry entry.
- **UI redesigned** — model cards, live per-image activity feed with top tags,
  rate + ETA, first-run setup overlay.
- **Output format unchanged.** Same `Json/<name>.json` files and
  `processed_log.json` — fully compatible with existing v2 data and pipelines.

### Added
- **Update tagged** mode: re-tags only images that already have a JSON,
  replacing old tags with the selected model's output — for migrating an
  already-tagged library to a better model.
- Hugging Face token field for gated models (AnimeTimm).
- Configurable parallel workers, per-run model/threshold, persistent settings.

### Removed
- Docker instance management, health checks, connection pools, API endpoint
  configuration, port juggling — all obsolete without containers.
- The Eagle plugin dependency (see Eagle Toolkit's Tag Merger).

### Fixed (vs v2 behavior)
- No more container startup failures, port conflicts, or unhealthy-instance
  stalls — there are no containers.
- Folder counts include nested subfolders.
- Crash-safe cancel/resume via the same append-only log design.

### Requirements changed
- No longer needed: Docker.
- Still needed: Python 3.9+ (one-time automatic environment setup).

---

## Eagle Toolkit — 1.0.0

New app replacing the `imagerenamer.py` and `eagletagger.py` helper scripts
with one two-tab UI. Pure Node — no Python, no databases.

### Renamer (replaces imagerenamer.py)
- **Collision-proof naming**: 10-digit names are reserved in memory and
  verified against the disk. The old script could generate duplicates under
  concurrency and didn't check disk at all if its database was missing.
- Image detection by file content (magic bytes) — much faster than opening
  every file, and no longer extension-dependent.
- Full old → new rename history kept as a log; no more SQLite file in your
  home directory.
- Same behavior otherwise: skips 10-digit-named and previously renamed files.

### Tag Merger (replaces eagletagger.py)
- **Confidence threshold** (default 0.35): the old script merged every tag in
  the JSON including 0.1-confidence noise — the main source of junk Eagle
  tags. Set 0 for the old keep-everything behavior.
- **Atomic metadata writes**: a crash mid-write can no longer corrupt an
  Eagle item's `metadata.json`.
- SQLite index and the rebuild / smart / use-index modes removed — a fresh
  scan runs each time and can't go stale. ("Smart Search" in the old script
  was non-functional: it ran identical code to "Use Existing Index".)
- Modes simplified to All / New only; New-only also resumes canceled runs.
- Same `processed.log` CSV columns as before.
