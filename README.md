# dataset_viewer

A research-focused viewer for every JSONL + inspect-`.eval` file under `experiments/`.

## Quickstart

```bash
# from repo root — the `viewer` extra pulls in fastapi/duckdb/agent-sdk/etc.
uv sync --extra viewer
cd apps/dataset_viewer/web && npm install  # one-time

# back here
make dev                                   # starts api on :8765 and web on :5173
```

Open http://127.0.0.1:5173.

## Run pieces separately

```bash
make api    # FastAPI + DuckDB on :8765
make web    # Vite dev server on :5173 (proxies /api → :8765)
```

## Keyboard

- `j` / `k` — next / prev row
- `s` — shuffle
- `/` — focus the regex filter
- `m` / `g` / `c` / `?` — toggle marks / judges / chat / SQL drawers

## Concepts

- **Datasets** are auto-detected: chat (`messages` array) → bubble view, flat rows → virtualized table, `step`-keyed metrics → line chart, `.eval` → inspect log view.
- **DuckDB reads JSONL on the fly** — no ingest step. Filters use `regexp_matches`, shuffling uses `ORDER BY hash(row, seed)`.
- **Marks** (tags + free-text notes) and **judge results** persist in `apps/dataset_viewer/.cache/state.duckdb`.
- **Judges** reuse `src/conditional_misalignment/judges.py` for the alignment + coherence presets; new presets are saved to the state DB.
- **Chat** is a real Claude Code session via `claude-agent-sdk`. Standard tools (Read/Edit/Bash/Glob/Grep) are on; Claude drives the UI through the `viewer` CLI (Bash subprocess), which hits the same HTTP API the frontend uses. Editing the CLI takes effect on the next subprocess invocation — no session restart.

## viewer CLI

The `viewer` script is installed as a console entry point (`uv pip install -e .`). It targets `http://127.0.0.1:8765` by default; override via `VIEWER_BASE_URL`.

```bash
viewer ls                                  # discover datasets
viewer info <path>                         # row count + columns + view kind
viewer open <path>                         # switch the user's view
viewer goto <idx>                          # navigate
viewer filter <regex> [--column COL]       # apply filter
viewer shuffle                             # reshuffle
viewer sample <n>                          # n random rows
viewer mark <idx> [--tags ...] [--note ..] # mark / annotate
viewer judge <preset> [--scope ...]        # run a judge (streams SSE)
viewer sql "<query>"                       # DuckDB SQL on the open file (FROM t)
viewer state                               # current viewer state
```

Use it as a real terminal tool too — same surface, same endpoints.

## Configuration

Set env vars in `.env` at the repo root (auto-loaded):

- `OPENAI_API_KEY` — required for judges
- `ANTHROPIC_API_KEY` — required for chat
- `DATASET_VIEWER_SCAN_ROOTS` — `:`-separated dirs to scan (default: `experiments/`)
- `DATASET_VIEWER_JUDGE_MODEL` — default `gpt-4.1-2025-04-14`
- `DATASET_VIEWER_PORT` / `DATASET_VIEWER_HOST` — bind address (default `127.0.0.1:8765`)

## Architecture

Single FastAPI process holds the global `ViewerState`; the frontend mirrors it via SSE
(`/api/state/events`). Both UI clicks and Claude tool calls publish into the same bus,
so the UI updates whether you click a row or Claude calls `goto_row(42)` from chat.

Chat sessions are isolated `ClaudeSDKClient` instances, kept in-process keyed by
session id. Each session streams its events on `/api/chat/sessions/{id}/events`.

State DB schema lives in `api/duck.py::_init_state_schema`.
