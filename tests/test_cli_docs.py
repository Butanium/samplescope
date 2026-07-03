"""The `sscope view` reference in SKILL.md / README.md is generated, not
hand-written — this test fails when a CLI change lands without rerunning
`python -m samplescope._gen_cli_ref` (same pattern as test_codegen.py for
the TS types)."""
from __future__ import annotations

import re

from samplescope._gen_cli_ref import BEGIN, END, TARGETS, generate


def test_generated_cli_reference_is_current():
    block = generate()
    pattern = re.compile(re.escape(BEGIN) + r"\n(.*?)\n" + re.escape(END), re.DOTALL)
    for path in TARGETS:
        m = pattern.search(path.read_text())
        assert m, f"{path}: missing generated-block markers"
        assert m.group(1) == block, (
            f"{path}: stale generated CLI reference — "
            "run: python -m samplescope._gen_cli_ref"
        )


def test_chat_preamble_preloads_skill(monkeypatch, tmp_path):
    """The embedded agent's system-prompt append must contain the full skill
    body (single source of truth), not a separate hand-written command list."""
    # Importing chat pulls in api.settings, whose import creates a state dir —
    # point it at a tmp dir in case this test is the first in-process import.
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    from samplescope.api.routes.chat import CLI_INTRO

    assert "sscope view judge <preset>" in CLI_INTRO  # generated reference present
    assert "embedded chat agent" in CLI_INTRO  # situational preamble present
    assert not re.search(r"^\s*viewer ", CLI_INTRO, re.M)  # old CLI name gone
