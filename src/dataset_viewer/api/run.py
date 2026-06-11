"""Entry point: `uv run python -m apps.dataset_viewer.api.run`."""
from __future__ import annotations

import os

import uvicorn


def main() -> None:
    """Start uvicorn bound to localhost only."""
    uvicorn.run(
        "apps.dataset_viewer.api.main:app",
        host=os.environ.get("DATASET_VIEWER_HOST", "127.0.0.1"),
        port=int(os.environ.get("DATASET_VIEWER_PORT", "8765")),
        reload=os.environ.get("DATASET_VIEWER_RELOAD", "0") == "1",
    )


if __name__ == "__main__":
    main()
