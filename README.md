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
  drives the UI through `sscope view` (Bash subprocess) hitting the same
  HTTP API the frontend uses.

## `sscope view` CLI

One binary, two halves: `sscope serve [DIR ...]` runs the server (bare
`sscope <dir>` is shorthand), `sscope view <cmd>` drives the open view.
`view` auto-discovers the running instance whose scan root contains your cwd
(registry: `~/.local/state/samplescope/instances.json`); override with
`SAMPLESCOPE_BASE_URL` or `--base-url`.

<!-- BEGIN GENERATED: sscope-view-reference (python -m samplescope._gen_cli_ref) -->
```
sscope view ls [options]
  # List discoverable datasets (JSONL + .eval files under scan roots).
  --filter TEXT                     substring match on path
sscope view info <path>
  # Schema-detect one dataset: row count, columns, view kind.
sscope view stats [path]
  # Per-column distribution breakdown (dtype, nulls, min/max, top values).
sscope view open <path>
  # Open a dataset in the viewer (UI switches live).
sscope view goto <idx>
  # Move the viewer to row index `idx`.
sscope view next
  # Step the viewer forward one row (state-aware).
sscope view prev
  # Step the viewer back one row (state-aware, clamped at 0).
sscope view filter <regex> [options]
  # Add a regex filter to the open dataset (AND-composed with existing ones).
  --column TEXT                     restrict to one column; omit for whole-row
sscope view filters
  # List the active filters (index, column, regex).
sscope view rm-filter <idx>
  # Remove the filter at index `idx` (see `sscope view filters`).
sscope view clear-filter
  # Clear all active filters.
sscope view shuffle [options]
  # Pick a fresh shuffle seed for the open dataset. Clears any active sort.
  --seed INTEGER                    explicit seed; omit for random
sscope view sort <column> [options]
  # Sort the open dataset by a column. Clears any active shuffle.
  --desc                            sort direction (default ascending)
sscope view clear-sort
  # Drop the active sort and return to natural / shuffled order.
sscope view sample <n>
  # Pull n random rows from the currently-open dataset.
sscope view rows <path> [options]
  # Read a window of rows from a dataset on disk.
  --offset INTEGER
  --limit INTEGER                   [default: 20]
  --filter TEXT                     regex filter (whole row or one column)
  --column TEXT                     filter only this column
  --shuffle INTEGER                 seed for stable shuffle
sscope view row <path> <idx>
  # Read a single row by its original index.
sscope view mark <idx> [options]
  # Mark / annotate a row in the currently-open dataset (or --path).
  --tags TEXT                       comma-separated tags
  --note TEXT
  --path TEXT                       defaults to the open dataset
sscope view unmark <idx> [options]
  # Remove a row's mark.
  --path TEXT
sscope view marks [options]
  # List marks across datasets, optionally narrowed.
  --path TEXT                       filter to one dataset
sscope view judges
  # List configured judge presets.
sscope view add-judge <name> [options]
  # Save (or replace) a judge preset.
  --prompt-file FILE                prompt-template file with {question}/{answer} slots (mutex with --import-path)
  --import-path TEXT                'module.path:attr' pointing at an inspect @scorer factory (mutex with --prompt-file)
  --score-field TEXT                [default: score]
  --schema-file FILE                optional JSON-schema file (prompt kind only); judge replies must conform
  --model TEXT                      inspect provider/model id
  --description TEXT
sscope view settings <action> [key] [value]
  # Read or write judge settings (currently only ``default_judge_model``).
sscope view judge <preset> [options]
  # Run a judge over rows; results stream to stdout one row at a time.
  --scope TEXT                      current | sample | indices  [default: current]
  --n INTEGER                       for scope=sample  [default: 10]
  --idx INTEGER (repeatable)        for scope=indices; repeat the flag
  --path TEXT
  --model TEXT
sscope view sql <query> [options]
  # Run a read-only DuckDB query. `FROM t` aliases the chosen JSONL.
  --path TEXT                       bound to FROM t; defaults to open dataset
  --apply TEXT                      bind to viewer: 'selection' narrows the main view to __idx; 'view' replaces the main view with the SQL result table; omit to just print the result.
sscope view clear-sql
  # Drop any applied SQL selection/view, restoring the natural view.
sscope view state
  # Print the current view state (open dataset, row, filter, shuffle, …).
sscope view highlights ls
  # List all highlight rules in display order.
sscope view highlights add <name> [options]
  # Create a new highlight rule. The id is auto-generated.
  --pattern TEXT                    literal substring or regex source
  --regex                           treat pattern as regex
  --case                            case-sensitive match
  --color TEXT                      hex color, e.g. #fde047  [default: #fde047]
  --role TEXT                       user|assistant|system|tool
  --column TEXT                     restrict to one table column
  --condition TEXT                  JS expression on (row, msg)
sscope view highlights rm <rule_id>
  # Delete a rule by id.
sscope view highlights toggle <rule_id>
  # Flip the ``enabled`` flag for a rule.
sscope view plot ls
  # List every tab currently in the plot panel.
sscope view plot add [options]
  # Add a new tab to the plot panel. Exactly one of --file / --plotly.
  --file FILE                       image (.png/.jpg/.svg/...) or .pdf to attach; kind auto-detected
  --plotly FILE                     JSON file with a plotly figure spec ({data, layout, ...})
  --title TEXT                      display label for the tab
sscope view plot rm <tab_id>
  # Close a single tab by id.
sscope view plot clear
  # Close every tab in the plot panel.
sscope view fields ls [options]
  # Show the currently-pinned fields for a dataset.
  --path TEXT                       defaults to the open dataset
sscope view fields set <columns...> [options]
  # Replace the pinned-field list for a dataset with the given columns.
  --path TEXT
sscope view fields add <column> [options]
  # Append a column to the pinned list.
  --path TEXT
sscope view fields rm <column> [options]
  # Remove a column from the pinned list.
  --path TEXT
sscope view fields clear [options]
  # Unpin every field.
  --path TEXT
```
<!-- END GENERATED: sscope-view-reference -->

## Configuration

Env vars (a `.env` in the launch directory is auto-loaded):

- `OPENAI_API_KEY` — required for the default judge presets
- `ANTHROPIC_API_KEY` — chat (a logged-in `claude` CLI session also works)
- `SAMPLESCOPE_SCAN_ROOTS` — `:`-separated dirs (CLI args take precedence)
- `SAMPLESCOPE_HOST` / `SAMPLESCOPE_PORT` — bind address
- `SAMPLESCOPE_CHAT_MODEL` — chat model override
- `SAMPLESCOPE_BASE_URL` — `sscope view` target (skips instance discovery)

## Architecture

Single FastAPI process holds the global `ViewerState`; the frontend mirrors
it via SSE (`/api/state/events`). UI clicks and Claude tool calls publish
into the same bus, so the view updates whether you click a row or Claude
calls `sscope view goto 42` from chat. The compiled frontend is served by the
same
process (`/api` routes win precedence); the vite dev server is for
development only.

State DB schema lives in `api/duck.py::_init_state_schema`.

## Development

```bash
make install   # uv sync --all-extras + npm install
make dev       # api (--reload) on :8765 + vite on :5173, serving DIR=.
make test      # pytest (API + CLI + playwright smoke)
```
