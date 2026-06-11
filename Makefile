# Development workflow. End users don't need this — they get a single-process
# app via `uv tool install samplescope` (the wheel embeds the built UI).

.PHONY: dev api web install build test clean

# Directory to serve during dev (override: make dev DIR=~/some/project)
DIR ?= .
API_PORT ?= 8765
WEB_PORT ?= 5173

install:
	uv sync --all-extras
	cd web && npm install

api:
	SAMPLESCOPE_PORT=$(API_PORT) uv run samplescope --reload $(DIR)

web:
	cd web && SAMPLESCOPE_API=http://127.0.0.1:$(API_PORT) WEB_PORT=$(WEB_PORT) npm run dev

dev:
	@which concurrently >/dev/null 2>&1 || (cd web && npm install --no-save concurrently)
	cd web && SAMPLESCOPE_API=http://127.0.0.1:$(API_PORT) WEB_PORT=$(WEB_PORT) \
	  npx concurrently -n api,web -c green,cyan \
	  "cd .. && SAMPLESCOPE_PORT=$(API_PORT) uv run samplescope --reload $(DIR)" \
	  "npm run dev"

build:
	cd web && npm run build

test:
	uv run pytest

clean:
	rm -rf web/node_modules web/dist src/samplescope/web_dist dist
