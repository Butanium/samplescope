# samplescope

A research-focused browser for JSONL / CSV / inspect-ai `.eval` datasets.
Point it at any directory; it auto-detects schemas and renders chat
transcripts as bubbles, flat rows as a virtualized table, training curves as
line charts, and `.eval` logs as rich sample cards — with regex/SQL
filtering, shuffling, marks/annotations, LLM judges, and an embedded Claude
chat that drives the UI.

## Install & run

```bash
uv tool install samplescope        # or: uvx samplescope
cd ~/my-project && samplescope     # serve datasets under cwd
samplescope results/ logs/ --port 9000   # explicit dirs / port
```

One process, one port — the built web UI ships inside the wheel. If the
default port is taken (e.g. another instance), the next free one is picked
automatically; running several instances against different projects is a
supported workflow.

The embedded Claude chat drawer ships by default (claude-agent-sdk); it
authenticates via `ANTHROPIC_API_KEY` or a logged-in `claude` CLI session.

## Keyboard

- `j` / `k` — next / prev row
- `s` — shuffle
- `/` — focus the regex filter
- `m` / `g` / `c` / `?` — toggle marks / judges / chat / SQL drawers

## Concepts

- **Datasets** are auto-detected: chat (`messages` array) → bubble view, flat
  rows → virtualized table, `step`-keyed metrics → line chart, CSV/TSV →
  table, `.eval` → inspect log view.
- **DuckDB reads files on the fly** — no ingest step. Filters use
  `regexp_matches`, shuffling uses `ORDER BY hash(row, seed)`.
- **Marks** (tags + free-text notes), **judge results**, and prefs persist in
  `~/.local/state/samplescope/<key>/state.duckdb`, keyed by the scan-root
  set — annotations survive restarts and the viewed repos stay clean.
- **Judges**: built-in presets plus user-defined ones (saved to the state
  DB). Needs `OPENAI_API_KEY` (or any inspect-ai-supported provider via the
  preset's model field).
- **Chat** is a real Claude Code session via `claude-agent-sdk`. Claude
  drives the UI through the `viewer` CLI (Bash subprocess) hitting the same
  HTTP API the frontend uses.

## `viewer` CLI

Installed alongside `samplescope`. It auto-discovers the running instance
whose scan root contains your cwd (registry:
`~/.local/state/samplescope/instances.json`); override with
`VIEWER_BASE_URL` or `--base-url`.

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

## Configuration

Env vars (a `.env` in the launch directory is auto-loaded):

- `OPENAI_API_KEY` — required for the default judge presets
- `ANTHROPIC_API_KEY` — chat (a logged-in `claude` CLI session also works)
- `SAMPLESCOPE_SCAN_ROOTS` — `:`-separated dirs (CLI args take precedence)
- `SAMPLESCOPE_HOST` / `SAMPLESCOPE_PORT` — bind address
- `SAMPLESCOPE_CHAT_MODEL` — chat model override
- `VIEWER_BASE_URL` — `viewer` CLI target (skips instance discovery)

## Architecture

Single FastAPI process holds the global `ViewerState`; the frontend mirrors
it via SSE (`/api/state/events`). UI clicks and Claude tool calls publish
into the same bus, so the view updates whether you click a row or Claude
calls `viewer goto 42` from chat. The compiled frontend is served by the same
process (`/api` routes win precedence); the vite dev server is for
development only.

State DB schema lives in `api/duck.py::_init_state_schema`.

## Development

```bash
make install   # uv sync --all-extras + npm install
make dev       # api (--reload) on :8765 + vite on :5173, serving DIR=.
make test      # pytest (API + CLI + playwright smoke)
```
