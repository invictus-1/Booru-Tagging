# Eagle Toolkit

Rebuild of the two tkinter Eagle scripts (ImageRenamer.py + EagleTagger.py)
as one modern app. Pure Node/Electron — **no Python, no setup, no database**.

```bash
npm install
npm start        # run
npm run build    # build the installer (dist/)
```

## Renamer

Gives every image a random, globally unique 10-digit name (extension kept) so
filenames work as stable IDs for tagging + Eagle matching.

- Skips files already named with 10 digits, files renamed in a previous run,
  and non-images (detected by content, not extension).
- Every rename is recorded in `rename_history.ndjson` (old → new mapping), so
  nothing is ever untraceable.
- **Run order matters:** rename → tag → merge. Renaming after tagging orphans
  the tag JSONs.

### Fixes vs the old script

- Collision-proof naming: numbers are reserved in memory and checked against
  the actual disk, not just a database that could be stale or deleted. The old
  version could generate duplicate names under concurrency.
- Image detection via magic bytes — much faster than opening every file with PIL.
- No SQLite database in your home folder.

## Tag Merger

Matches tag JSONs (from Booru Tagger V3 or the old autotagger — same format)
to Eagle items by filename and merges the tag names into each item's
`metadata.json`.

- **Min tag confidence** (new): the old script merged *every* tag in the JSON,
  including 0.1-confidence noise — a major source of wonky Eagle tags.
  Default 0.35; set to 0 for the old keep-everything behavior.
- Atomic writes: metadata.json is written to a temp file then swapped in — a
  crash can never corrupt an Eagle item (the old version could).
- Modes: **All items** / **New only** (skips already-merged items; also
  resumes a canceled run for free).
- The SQLite index + rebuild/smart/use-index modes are gone: a fresh scan runs
  every time (seconds, even at hundreds of thousands of files) and can never
  go stale. The old "Smart Search" mode was actually dead code.
- Logs: `processed.log` (CSV, same columns as before) and
  `merge_processed.ndjson`, stored next to the app (or in `%APPDATA%\eagle-toolkit`
  when installed).

**Eagle note:** Eagle caches metadata in memory. Merge while Eagle is closed,
or force a library re-sync afterwards, so it picks up the new tags.

## Files

```
main.js            Electron main — job orchestration
preload.js         IPC bridge
lib/walk.js        Folder walking, NDJSON logs, concurrency pool
lib/renamer.js     Renamer engine
lib/merger.js      Merger engine
renderer/          UI (vanilla, dark theme, two tabs)
```
