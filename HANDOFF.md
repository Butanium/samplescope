# HANDOFF: extract dataset_viewer into a standalone, globally-installable tool

Written 2026-06-11 by a previous Claude session (coloom project) after discussing
the design with Clément. You are taking over a **spec'd but unstarted** task.
Everything below was agreed with him; deviate where the code argues otherwise,
but flag deviations in your summary.

## What this is

`~/projects2/astra/conditional_misalignment/apps/dataset_viewer/` is a
research dataset viewer (FastAPI + DuckDB API, React/Vite web app, `viewer`
CLI, optional embedded Claude chat via claude-agent-sdk). It auto-detects and
renders JSONL datasets (chat/table/metrics views) and inspect-ai `.eval` logs,
with regex/SQL filtering, shuffling, marks/annotations, and LLM judges.
Read its `README.md` + `CLAUDE.md` first — the CLAUDE.md has non-obvious
design decisions (nav cursor, sort/shuffle mutex, `.eval` materialization,
prefs hydration, SSE event-name registration, chat thinking config).

Clément wants it extracted to **this folder** (`~/tools/dataset-viewer/`) as
its own repo, installable globally (`uv tool install` / `uvx`), runnable
against any local directory.

## Why (motivating friction, observed live)

- The current app is bound to the astra repo: scan root defaults to its
  `experiments/`, runs via `make dev` with TWO processes (vite :5173 hardcoded
  proxying to api :8765), both ports currently occupied by Clément's live
  instance. Viewing another project's data means hand-editing configs for a
  second port-pair.
- We wanted to view inspect `.eval` logs + result files from
  `~/projects2/weird-personas/explorations/01_2026-06-11_victor_trait_probes/`
  and couldn't without that surgery.

## Verified facts (checked 2026-06-11, re-verify cheaply)

- `grep -rn conditional_misalignment apps/dataset_viewer/api/ cli.py` → **no
  hits**: the data layer has no import coupling to the astra package. The
  README's claim that judges reuse `src/conditional_misalignment/judges.py`
  is stale or soft — check `api/judges/` to see what presets actually import.
- The web frontend is vite-only: `api/main.py` has **no StaticFiles mount**;
  `web/vite.config.ts` hardcodes port 5173 and proxy target
  `http://127.0.0.1:8765`. `web/dist/` exists (a build has been run).
- The `viewer` CLI is a pure HTTP client of the same `/api/*` routes the
  frontend uses; base URL from `VIEWER_BASE_URL` (default `127.0.0.1:8765`).
- The embedded chat spawns the `viewer` CLI as a Bash subprocess (so the
  server can inject env into it — see CLI discovery below).
- It reads JSONL + `.eval` only; **no CSV** (DuckDB underneath, so CSV is a
  small addition).
- State (marks, judge results, prefs) lives in `.cache/state.duckdb` inside
  the app folder.

## Agreed design

1. **Repo**: this folder becomes the repo (git init here). Package name:
   `dataset-viewer` (binary `dataset-viewer`; keep the `viewer` entry point
   for the interaction CLI — two console scripts).
2. **Single-process serving**: build `web/dist` into the wheel; FastAPI
   serves it via a StaticFiles mount registered AFTER the `/api` routes (API
   wins precedence). One process, one port, zero npm for users. Vite dev
   server remains for development only (make its proxy target/port
   env-configurable while you're in there). Pattern reference:
   `~/projects2/coloom` serves `web/dist` via `--static-dir` the same way.
   Packaging: hatch build hook (or equivalent) running `npm run build` at
   wheel build time — mind Clément's global `ignore-scripts=true` npm config
   (direct `npm run build` is fine; postinstall scripts are not).
3. **CLI**: `dataset-viewer [DIR ...] [--port PORT] [--host]` — scan roots
   default to cwd. Replaces `DATASET_VIEWER_SCAN_ROOTS`-only config (keep the
   env vars working).
4. **Instance discovery** (new): server registers itself in
   `~/.local/state/dataset-viewer/instances.json` (scan roots, host:port,
   pid; clean up on exit, ignore stale pids). The `viewer` CLI picks the
   instance whose scan root contains cwd; `VIEWER_BASE_URL` / `--base-url`
   override; ambiguity → error listing running instances. The chat-spawned
   subprocess gets `VIEWER_BASE_URL` injected by the server (self-target).
5. **State DB**: move to `~/.local/state/dataset-viewer/`, keyed by scan
   root (hash), so annotations survive and repos stay clean. Migration from
   old `.cache/state.duckdb` not needed (Clément's existing marks live in the
   astra copy, which stays — see below).
6. **CSV support**: DuckDB `read_csv` alongside JSONL. (Motivation: our
   probe results were CSV. New convention going forward is JSONL, but CSV
   files exist in the wild.)
7. **Judges**: builtin default presets + user-defined presets persisted in
   the state DB (already the mechanism); kill any astra import if one turns
   up. Judge model stays env-configurable.
8. **Chat = optional extra** (`dataset-viewer[chat]`): claude-agent-sdk +
   ANTHROPIC_API_KEY only needed for the chat drawer. App must degrade
   gracefully without it.
9. **Astra's vendored copy stays untouched** until Clément has used the
   standalone for a few days. Do NOT touch the running instance (:5173/:8765)
   or its `.cache/`. Also :5174 is coloom's dev vite — avoid.

## Suggested verification

- `uv tool install --from ~/tools/dataset-viewer dataset-viewer` (or `uvx --from . dataset-viewer`), then run against
  `~/projects2/weird-personas/explorations/` — the `.eval` logs under
  `01_2026-06-11_victor_trait_probes/logs/` should render in the inspect view,
  and `results/probes_v2.csv` should render as a table once CSV lands.
- `viewer ls` from inside that dir finds the instance via discovery, no env.
- Playwright-click the main affordances rather than screenshot-smoking
  (Clément's standing preference for UI verification; see his global memory
  `feedback_ui_testing_scope.md`). Hermetic tests > manual.
- Two instances at once (different dirs/ports) + `viewer` targeting each by
  cwd — the multi-instance scenario is the whole point.

## Open questions for Clément (ask before going off-spec)

- Repo remote/publish? (He mused about open-sourcing; `~/tools/` chosen
  deliberately to not preclude it.)
- Keep the name `dataset-viewer` or rename (`dsv`?) — he shrugged at naming.
- Whether astra should eventually consume the package (delete vendored copy)
  — deferred, his call after trial period.

## Context: what this unblocks

Immediate consumer: the weird-personas implausible-agents exploration
(`~/projects2/weird-personas/explorations/01_2026-06-11_victor_trait_probes/`,
see its `notes.md`) — browsing probe completions + judge verdicts beat raw
CSV reading the moment we audited the judge. Clément also wants sample
metadata (persona/frame/question) filterable; the inspect samples already
carry it, and `.eval` materialization turns metadata into columns, so
filtering should work out of the box — verify with those logs.
