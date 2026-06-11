---
name: samplescope
description: Browse experiment outputs (JSONL/CSV/inspect-ai .eval) together with the human via samplescope — start the server, then drive the human's browser view from the terminal with the `viewer` CLI (open files, jump to rows, filter, mark, judge, pin plots). Use when the human wants to look at samples/results/transcripts together, asks to "open X in the viewer", or when you want to show them specific rows instead of pasting walls of text.
---

# samplescope

A local web app for close-reading experiment outputs, plus a `viewer` CLI
that drives the SAME view the human has open in their browser. You change
the view from your shell; their screen follows live. This makes it the best
way to *show* the human data: instead of pasting samples into chat, open the
file, jump to the interesting row, and tell them to look.

## Start (or find) the server

```bash
viewer state                 # a server already running for this cwd? (auto-discovery)
samplescope <dir>            # serve datasets under <dir>; prints the URL
```

- Run it in the background; it stays up. Relaunching on the same dirs is
  idempotent (prints the existing URL instead of starting a twin).
- Default port 8765, auto-picks the next free one — multiple instances for
  different projects coexist fine.
- Give the human the printed URL (e.g. http://127.0.0.1:8766).
- The `viewer` CLI auto-targets the instance whose scan root contains your
  cwd. Outside any scan root: set `VIEWER_BASE_URL` or pass `--base-url`.

## Drive the shared view

```bash
viewer ls                                  # what files does the server see
viewer info <path>                         # row count + columns + view kind
viewer open <path>                         # switch the human's view to this file
viewer goto <idx>                          # jump their view to row idx
viewer filter <regex> [--column COL]       # narrow visible rows (regex)
viewer sort <column> [--desc]              # sort
viewer shuffle                             # reshuffle (stable seed)
viewer sample <n>                          # print n random rows to YOUR stdout
viewer mark <idx> [--tags t1 t2] [--note "…"]   # annotate a row (persists)
viewer judge <preset> [--scope all|filtered|row] # run an LLM judge, streams results
viewer sql "SELECT __idx, * FROM t WHERE …"      # DuckDB SQL over the open file
viewer plot add --file path/to/fig.png --title "…"  # pin an image/PDF to the plot panel
viewer plot add --plotly fig.json --title "…"       # pin a plotly figure
viewer fields add <column>                 # pin a metadata column above each chat row
viewer state                               # current shared view state
```

Paths are relative to the server's serving root — use exactly what
`viewer ls` prints. `viewer --help` / `viewer <cmd> --help` for the rest.

## Collaboration patterns

- **"Look at this one"**: `viewer open <file>` → `viewer goto 42` → tell the
  human what to look at. Faster and richer than pasting the sample.
- **Triage together**: `viewer filter <regex>`, the human reads with j/k in
  the browser while you `viewer mark` the noteworthy rows with tags/notes.
  Marks persist across restarts — they're a shared annotation layer.
- **Narrow by query**: `viewer sql 'SELECT __idx, … FROM t WHERE …'` rows
  with `__idx` can be applied as a selection so the human pages through just
  the matching rows.
- **Judge at scale, audit by hand**: `viewer judge <preset>` over the
  filtered set, then jump to outliers.

## Make your output files viewer-friendly

When generating JSONL the human will read here, give each row a
`messages: [{role, content}, ...]` list — it renders as chat bubbles (the
best reading view); all other scalar fields stay as metadata (filterable,
sortable, judgeable). Don't emit bare `prompt`/`completion` string columns:
they fall back to a wide table and are painful to read. Flat metric rows
with a numeric `step` column render as training curves. inspect-ai `.eval`
logs and CSV/TSV work as-is.
