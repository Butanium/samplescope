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
