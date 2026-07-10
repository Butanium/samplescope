---
name: samplescope
description: Browse experiment outputs (JSONL/CSV/inspect-ai .eval) together with the human via samplescope — start the server, then drive the human's browser view from the terminal with `sscope view` (open files, jump to rows, filter, mark, judge, pin plots). Use when the human wants to look at samples/results/transcripts together, asks to "open X in the viewer", or when you want to show them specific rows instead of pasting walls of text.
---

# samplescope

A local web app for close-reading experiment outputs, plus an `sscope view`
CLI that drives the SAME view the human has open in their browser. You change
the view from your shell; their screen follows live. This makes it the best
way to *show* the human data: instead of pasting samples into chat, open the
file, jump to the interesting row, and tell them to look.

**Which situation are you in?**

- **Terminal session** (Claude Code in a repo): you may need to start or find
  the server — see the next section.
- **Embedded chat agent** (the chat drawer inside samplescope): the server is
  already running and `sscope view` is pre-targeted at it via
  `SAMPLESCOPE_BASE_URL`. Skip the server section entirely; just drive.

## Start (or find) the server — terminal sessions only

```bash
sscope view state            # a server already running for this cwd? (auto-discovery)
sscope <dir>                 # serve datasets under <dir>; prints the URL
                             # (shorthand for `sscope serve <dir>`)
```

- Run it in the background; it stays up. Relaunching on the same dirs is
  idempotent (prints the existing URL instead of starting a twin).
- Default port 8765, auto-picks the next free one — multiple instances for
  different projects coexist fine.
- Give the human the printed URL (e.g. http://127.0.0.1:8766).
- `sscope view` auto-targets the instance whose scan root contains your
  cwd. Outside any scan root: set `SAMPLESCOPE_BASE_URL` or pass
  `sscope view --base-url <url> <cmd>`.

## Drive the shared view

The core loop:

```bash
sscope view ls                      # what files does the server see
sscope view open <path>             # switch the human's view to this file
sscope view goto 42                 # jump their view to row 42
sscope view state                   # current shared view state
```

Paths are relative to the server's serving root — use exactly what
`sscope view ls` prints.

Full command reference (generated from the CLI itself — trust it over memory):

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
  # Apply a regex filter to the open dataset.
  --column TEXT                     restrict to one column; omit for whole-row
sscope view clear-filter
  # Remove any active regex filter.
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

## Collaboration patterns

- **"Look at this one"**: `sscope view open <file>` → `sscope view goto 42` →
  tell the human what to look at. Faster and richer than pasting the sample.
- **Triage together**: `sscope view filter <regex>`, the human reads with j/k
  in the browser while you `sscope view mark <idx> --tags interesting,weird
  --note "…"` the noteworthy rows. Marks persist across restarts — they're a
  shared annotation layer.
- **Narrow by query**: `sscope view sql 'SELECT __idx, … FROM t WHERE …'
  --apply selection` narrows the human's view to the matching rows so they
  page through just those.
- **Judge at scale, audit by hand**: `sscope view judge <preset> --scope
  sample --n 50` (or `--scope indices --idx 3 --idx 17` for specific rows),
  then jump to outliers. `--scope current` (the default) judges only the row
  the view is on.

## Make your output files viewer-friendly

When generating files the human will read here, pick a schema the viewer
auto-detects a good view for (detection sniffs the first 64 rows):

- **Chat view (best for anything conversation-shaped)** — give each JSONL row
  a `messages: [{role, content}, ...]` list; it renders as chat bubbles.
  Rules that matter:
  - EVERY row needs a non-empty `messages` list and every message needs both
    a `role` and a `content` key — detection is all-rows, so one empty or
    malformed row silently demotes the whole file to the generic card view.
  - `content` is a plain string (simplest) or an OpenAI-style block list
    (`[{type: "text", text: ...}, ...]`).
  - Reasoning traces render as collapsible panels: put them in
    `reasoning_content` / `reasoning` / `thinking` on the message, or as
    `{type: "reasoning"|"thinking", ...}` blocks inside a content list.
  - All other top-level row fields stay as metadata (filterable, sortable,
    judgeable, pinnable above each row).
- **Card view (per-sample JSON)** — flat rows where some field holds free
  text >200 chars. The right shape for per-sample dumps that aren't
  conversations (bare `prompt`/`completion` columns land here — readable,
  but prefer `messages` when the data really is a dialogue).
- **Table view** — flat rows of short scalars only.
- **Metrics view** — flat numeric rows with a `step` column that's ~unique
  per row (a real logging curve), ≥3 numeric columns, no long text.
- **Eval logs** — inspect-ai `.eval` files are first-class; no conversion.
- **CSV/TSV** — sniffed with the same heuristics as JSONL (a long-text CSV
  opens as cards, a step curve as a plot), and JSON-encoded string cells
  render expanded in the card view. Still prefer JSONL for anything with
  nested structure; chat view never triggers from CSV.

Every multi-sample view has a samples/table/plot/stats toggle in the header;
`stats` shows per-column distributions (pies for categoricals, histograms for
numerics) over the currently visible (filtered) rows — also available as
`sscope view stats`.

Plot panel: pin matplotlib output via `sscope view plot add --file fig.png`;
plotly figures via `--plotly fig.json` (the JSON is `figure.to_json()` output
or any `{data, layout}` spec).
