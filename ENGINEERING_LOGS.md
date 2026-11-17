# samplescope — engineering log

Append-only. What changed and why, plus gotchas. Design that holds today lives in
CLAUDE.md; this is the chronology.

## 2026-09-26 — UX sweep (opus-5.5)

Pain list mined from the transcript archive, then reproduced on a throwaway
instance over a real research repo (read-only).

- **Suite was red on HEAD** (`test_chat_metadata_uses_shared_field_layout`,
  order-dependent). Cause was a product bug: every field-layout save stamped the
  view's *implicit* `defaultHidden`, so a chat file borrowing a JSON-card layout
  (cross-schema inheritance) unfolded all its metadata. Saves (UI and
  `sscope view fields`) now store the policy only when the user set it. Existing
  prefs saved before this still carry the stamped value.
- **Row-index box** fired a goto per keystroke while being controlled by the SSE
  echo, so fast typing landed on the wrong row and Backspace jumped to 0. Typed
  digits are a draft now (Enter/blur commits, Esc reverts); spinner/arrow keys
  still step immediately — told apart by `InputEvent.inputType` (empty for
  spinner steps). Gotcha: Esc calls `blur()` inside the keydown handler, and the
  blur handler runs before the draft reset renders, hence the `idxEscaped` ref.
- **Header path** truncated from the right, hiding the file name at ≤1400px.
  Basename line + left-truncated directory line (`direction: rtl` plus a trailing
  LRM so the slash stays put).
- **Bad dataset paths** were bare 500s everywhere. `safe_path` raises 4xx with a
  detail naming path and root; `lib/notice.ts` is a one-slot app-wide notice for
  failures the user would otherwise never see. `sscope view open` resolves
  cwd-relative paths. The generated CLI reference only takes a command
  docstring's *first line*, so detail goes in later paragraphs when the
  generated SKILL.md section must not change.
- **Chat subprocess leak.** Restored drawer tabs were all resumed on mount and
  nothing ever stopped a session, so the live server had carried four `claude`
  processes since July. Idle reaper + lazy per-tab re-attach + per-id resume
  lock (concurrent resumes orphaned a process). Gotcha found while testing: a
  session that never got a message has no SDK transcript, so after a reap (or
  any restart) it couldn't resume and the tab was dead — it now restarts fresh.
  Verified with real subprocess counts under `SAMPLESCOPE_CHAT_IDLE_MINUTES=0.5`
  (3 tabs → 0 after reap → 1 on reload → send re-attaches), sends faked with
  `page.route` so no model turn ran.
- **Error text regression caught in the same pass:** 5e3cc62 made API errors
  carry the server's `detail` as the message, which silently broke
  `ChatTab.send`'s `String(e).includes("404")` re-attach check. Errors are now
  `ApiError` with `.status`; check the status, never the message.
- **Comparison filters** (`col >= 3`): Clément's two 07-21 requests. Kept to the
  header box (no new control): literal mode + a picked column + comparison
  syntax. The CLI can list them but not set them — a new `filter` option would
  change the generated SKILL.md reference, which needs Clément's approval.
- **Pair files render as chat.** `{prompt, completion}`-style rows (and
  response/answer/output variants) detect as `chat` with `chat_fields`; the
  frontend synthesizes `messages`, so the per-file converter scripts research
  repos had accumulated are unnecessary. Design choices: detection requires the
  response column itself to carry long text (a gold-label `{question, answer}`
  file with short answers is not a transcript), and the old card rendering stays
  one click away as `view=cards`. The `wide_text` test fixture had long
  `answer`s on half its rows, i.e. it *was* a pair file under the rule; its
  column was renamed `rationale` because the fixture exists for the cards view.
- **Skill edits are repo commits.** `~/.claude/skills/samplescope` symlinks into
  this repo (`src/samplescope/skill/SKILL.md`), and ~/.claude doesn't track it,
  so skill changes are committed and pushed here. `ls --json` and
  `filter --cmp` went in with the regenerated reference (Clément approved
  skill edits for this sweep).
- Before pushing a sweep, grep the unpushed commit *messages* too, not just the
  diffs: two messages named a private research column and a home-dir path and
  were reworded with `git filter-branch --msg-filter` over
  `origin/master..HEAD` (unpushed only).
- **Floating rail over text.** The view pane reserves the rail's footprint as
  right padding (56/44px) and the theme toggle became a one-button cycler, so
  the rail stays one button wide. The pane-level gutter also shifts the view's
  own toolbars left; accepted, since the rail sits over this pane whether or
  not a drawer is open.
- **Tree ignore defaults.** `.venv/.git/node_modules/__pycache__` are a built-in
  part of the ignore list (client-side, `BUILTIN_IGNORE`), lifted by the same
  master checkbox. The server stops walking `.git`/`__pycache__` only — the
  others must still be listed so the checkbox can show them. Warm scan time
  (~2.3s for 5.6k entries) is not the walk; not investigated further.
- **Stats latency** was N×re-parse of the source (several queries per column
  over the raw subquery). A per-request temp table on the cursor's own
  connection fixes it; byte-identical output checked on a real 12MB CSV.
- **`.markdown` outer margins** made every one-line string field 16px taller
  than numeric ones (the `<p>` margins stay inside a flex item).
- **Stats charts are cross-filters; histogram bins click-to-filter.** A column's
  chart ignores the filters on that column, which is what makes a click toggle
  (before, the filtered column re-binned over its own selection). Bin counts
  are now assigned by comparing against the returned edge doubles, so a bar and
  its filter always agree; the old `floor((x-min)/width)` could put an on-edge
  value in the neighbouring bin.
- **Scan cost** was per-file Path + stat + sort over every file in the repo
  (79k), not the walk; extension check first. Remaining ~0.9 s is `os.walk`
  over ~10k dirs on the slow volume.

## 2026-11-17 — transcript view (agent sessions + judge incidents)

Built for a judge-validation pass over coding-agent sessions: read a long
session, see where each LLM judge flagged an incident, label the judge.

- New view kind `transcript` for a judgments JSONL (`session_id` + `incidents`
  per row); events come from `{session_id}.json` under `--transcripts DIR`.
  Kept the judgments file as the dataset so filter / sort / stats / SQL / the
  CLI all apply to it unchanged; the only new backend is `routes/transcripts.py`.
- Sessions reach thousands of events with 100 KB tool results: the list is
  virtualized, results / thinking / system fold by default (a per-kind
  open / folded / hidden select, pref `transcript.kindModes`), and the server
  clips strings over 20k chars until the reader asks for the event whole.
- Ctrl+F cannot see a virtualized list, hence the in-view "find in session"
  (substring over text + tool input; matching events unfold and are listed even
  if their kind is hidden). It searches the clipped text, so a hit past the
  20k-char cut of one event is missed until that event is loaded whole.
- Judges are matched across models by proximity of their action events
  (within 2: one cites the call, the other its result), which feeds the
  overview grid at the top of the panel and the "also <judge> #k" chip.
- The table view's idx cell now opens the row as a sample (it was the only way
  from the judgments table to a transcript without the header toggle).
- Labels: append-only JSONL beside the dataset rather than `state.marks`, so
  the project's scripts read them without the state DB and they version with
  the results. `label: null` records a cleared label.
- Review progress: `/api/transcripts/progress` counts labelled vs total
  incidents (and "firm" ones: every `field>=n` term of the `firm` param,
  default `severity>=3,out_of_scope>=2`) and lists the rows still holding unlabelled
  ones. The panel's "rows" select applies that list as an SQL selection
  (`__idx IN (…)` with a trailing comment naming the scope), so it rides the
  existing URL/state plumbing. The list is a snapshot on purpose: a row must
  not vanish from under the reader the moment its last incident is labelled.
- Scale chips colour by level over one five-step ramp (`LEVEL_CLS`); a 1-3
  scale uses steps 1, 3 and 4 of it so its top reads like a high level of the
  1-5 severity scale. `SCALE_MAX` names the scales that are not 1-3.
- First real judgments (20 sessions × 2 judges): labels are keyed without the
  file name, because a run directory holds `judgments.jsonl` and derived copies
  (merged, with a reference judge added) that must share them. One Task call
  cited by six incidents overflowed the event head, so judge chips sit on their
  own wrapping row; the cross-judge grid groups with union-find (the greedy
  pass depended on incident order).
- Pinned transcript tabs (`pin=<session id>`). Clément wanted several
  transcripts open side by side; with one process-wide ViewerState every tab
  showed the row the last one opened. Rather than make row state per-tab for
  the whole app, a pinned tab opts out of the shared state entirely (see
  CLAUDE.md). Also fixed here: `useRowPage` / `useRowFeed` were not keyed on
  the SQL selection, so applying one left the visible-row list stale.
- The datasets sidebar folds (button right of refresh; pref `tree.folded`) to a
  28 px strip with the unfold button. Folded, `DatasetTree` stays mounted but
  hidden, because its effect is what records the opened-files history.
