"""Guard: the committed TS types are regenerated from the live OpenAPI schema.

`web/src/lib/api-types.gen.ts` is generated from the FastAPI schema (the Pydantic
models) via `npm run gen:types`. This test reruns that pipeline into a temp file
and asserts the committed copy matches — so a backend model change that isn't
followed by a regen fails CI instead of silently drifting the frontend types
(the failure mode that let a missing `kind` literal 500 at runtime).

Skips cleanly when the node toolchain isn't available (e.g. `npm install` hasn't
run in `web/`), mirroring how test_web.py skips without a built `web/dist`.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
GEN_BIN = REPO / "web" / "node_modules" / ".bin" / "openapi-typescript"
COMMITTED = REPO / "web" / "src" / "lib" / "api-types.gen.ts"


@pytest.mark.skipif(not GEN_BIN.exists(), reason="openapi-typescript not installed (run `npm install` in web/)")
def test_generated_types_match_schema(tmp_path: Path):
    schema = subprocess.run(
        [sys.executable, "-m", "samplescope._openapi"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    schema_path = tmp_path / "openapi.json"
    schema_path.write_text(schema)
    out_path = tmp_path / "api-types.gen.ts"
    subprocess.run(
        [str(GEN_BIN), str(schema_path), "-o", str(out_path)],
        cwd=REPO / "web",
        capture_output=True,
        text=True,
        check=True,
    )
    expected = out_path.read_text()
    actual = COMMITTED.read_text()
    assert actual == expected, (
        "web/src/lib/api-types.gen.ts is stale — a backend model changed without "
        "a regen. Run `cd web && npm run gen:types` and commit the result."
    )
