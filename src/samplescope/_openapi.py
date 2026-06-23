"""Dump the FastAPI OpenAPI schema as JSON.

Run via ``python -m samplescope._openapi`` (prints to stdout). The web build's
``npm run gen:types`` pipes this through ``openapi-typescript`` to regenerate
``web/src/lib/api-types.gen.ts`` — making the TS types for backend models a
*generated* artifact that can't drift from the Pydantic source.

Importing the app derives the schema from route + model definitions only; it
opens no DB connection (that happens in the lifespan, not at import) and makes
no network calls. We point ``XDG_STATE_HOME`` at a throwaway dir so the import
doesn't create a cache dir under the user's real ``~/.local/state``.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile


def _dump() -> None:
    from .api.main import app

    # sort_keys for byte-stable output, so regeneration is deterministic and the
    # staleness test (tests/test_codegen.py) compares cleanly.
    json.dump(app.openapi(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def main() -> None:
    # If the caller already isolated XDG_STATE_HOME (tests, CI), respect it.
    # Otherwise resolve SETTINGS (at import) against a throwaway dir that's
    # cleaned up on exit — don't create (or leak) a cache dir under the user's
    # real ~/.local/state just to read the schema.
    if os.environ.get("XDG_STATE_HOME"):
        _dump()
        return
    with tempfile.TemporaryDirectory(prefix="sscope-openapi-") as td:
        os.environ["XDG_STATE_HOME"] = td
        _dump()


if __name__ == "__main__":
    main()
