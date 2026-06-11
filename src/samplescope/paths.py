"""XDG-style filesystem locations shared by settings + instance registry.

Kept dependency-free so both `api.settings` and `instances` can import it
without cycles.
"""
from __future__ import annotations

import os
from pathlib import Path

STATE_HOME = (
    Path(os.environ.get("XDG_STATE_HOME") or "~/.local/state").expanduser()
    / "samplescope"
)
INSTANCES_PATH = STATE_HOME / "instances.json"
