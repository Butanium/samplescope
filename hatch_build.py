"""Hatch build hook: compile the web frontend into the wheel.

Runs `npm ci` + `npm run build` in `web/` and stages the output at
`src/dataset_viewer/web_dist/`, which the wheel picks up via the `artifacts`
config. So `uv tool install dataset-viewer` (or `uvx`) ships a fully
self-contained single-process app — users never touch npm.

Requires node/npm at *build* time only. `npm run build` invokes vite/tsc
directly (not a lifecycle script), so a global `ignore-scripts=true` npm
config does not interfere.

Set DATASET_VIEWER_SKIP_WEB_BUILD=1 to reuse an existing web_dist/ (useful
for fast iteration on Python-only changes).
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class WebDistBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        if self.target_name != "wheel":
            return
        root = Path(self.root)
        web = root / "web"
        staged = root / "src" / "dataset_viewer" / "web_dist"

        if os.environ.get("DATASET_VIEWER_SKIP_WEB_BUILD") == "1":
            if not (staged / "index.html").exists():
                raise RuntimeError(
                    "DATASET_VIEWER_SKIP_WEB_BUILD=1 but no existing "
                    f"{staged}/index.html to reuse"
                )
            return

        if shutil.which("npm") is None:
            raise RuntimeError(
                "npm is required to build the dataset-viewer wheel "
                "(it compiles the web UI). Install node, or set "
                "DATASET_VIEWER_SKIP_WEB_BUILD=1 to reuse a previous build."
            )

        if not (web / "node_modules").is_dir():
            subprocess.run(["npm", "ci"], cwd=web, check=True)
        subprocess.run(["npm", "run", "build"], cwd=web, check=True)

        if staged.exists():
            shutil.rmtree(staged)
        shutil.copytree(web / "dist", staged)
