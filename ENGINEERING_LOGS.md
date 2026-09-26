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
