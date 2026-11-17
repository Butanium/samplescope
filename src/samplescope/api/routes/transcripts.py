"""Agent-session transcripts with judge incidents anchored on them.

The open dataset is a JSONL of judgments (one row per session × judge model,
each with an `incidents` list citing event indices). The session itself is a
separate normalized JSON file, `{session_id}.json`, holding an `events` list;
it is resolved in the directory given by `sscope serve --transcripts DIR`
(or a row's own `session_path`). Human labels on incidents are appended to
`human_labels.jsonl` next to the judgments file.
"""
from __future__ import annotations

import json
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from ..duck import safe_path
from ..settings import SETTINGS

router = APIRouter(prefix="/api/transcripts", tags=["transcripts"])

LABELS_FILENAME = "human_labels.jsonl"
_SESSION_ID_RE = re.compile(r"^[\w.\-]+$")


def _session_file(dataset: Path, session_id: str, session_path: str | None) -> Path:
    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(400, f"invalid session id: {session_id!r}")
    candidates: list[Path] = []
    if session_path:
        candidates.append(Path(session_path).expanduser())
    if SETTINGS.transcripts_dir is not None:
        candidates.append(SETTINGS.transcripts_dir / f"{session_id}.json")
    candidates.append(dataset.parent / "sessions" / f"{session_id}.json")
    for c in candidates:
        if c.is_file():
            return c.resolve()
    raise HTTPException(
        404,
        f"no transcript for session {session_id}: looked at {', '.join(str(c) for c in candidates)}"
        " (pass the directory with `sscope serve <dir> --transcripts DIR`)",
    )


@lru_cache(maxsize=4)
def _load_session_cached(path: str, mtime_ns: int) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _load_session(p: Path) -> dict:
    return _load_session_cached(str(p), p.stat().st_mtime_ns)


def _clip_value(v: Any, clip: int) -> tuple[Any, bool]:
    """Clip long strings anywhere inside a tool input; report whether any was cut."""
    if isinstance(v, str):
        return (v[:clip], True) if len(v) > clip else (v, False)
    if isinstance(v, dict):
        out, cut = {}, False
        for k, x in v.items():
            out[k], c = _clip_value(x, clip)
            cut = cut or c
        return out, cut
    if isinstance(v, list):
        pairs = [_clip_value(x, clip) for x in v]
        return [x for x, _ in pairs], any(c for _, c in pairs)
    return v, False


def _clip_event(ev: dict, clip: int) -> dict:
    out = dict(ev)
    text = ev.get("text") or ""
    out["text_len"] = len(text)
    clipped = len(text) > clip
    if clipped:
        out["text"] = text[:clip]
    if ev.get("tool_input") is not None:
        out["tool_input"], cut = _clip_value(ev["tool_input"], clip)
        clipped = clipped or cut
    out["clipped"] = clipped
    return out


@router.get("/session")
def get_session(path: str, session_id: str, session_path: str | None = None, clip: int = 20000) -> dict:
    """One session with its events; strings longer than `clip` chars are cut
    (`clipped: true`) and fetched whole through `/event` when expanded."""
    p = _session_file(safe_path(path), session_id, session_path)
    doc = _load_session(p)
    events = doc.get("events")
    if not isinstance(events, list):
        raise HTTPException(422, f"{p} has no `events` list")
    return {
        **{k: v for k, v in doc.items() if k != "events"},
        "file": str(p),
        "n_events": len(events),
        "events": [_clip_event(e, clip) for e in events],
    }


@router.get("/event")
def get_event(path: str, session_id: str, idx: int, session_path: str | None = None) -> dict:
    """One event, unclipped."""
    p = _session_file(safe_path(path), session_id, session_path)
    events = _load_session(p).get("events") or []
    for e in events[idx : idx + 1] + events:
        if e.get("idx") == idx:
            return {**e, "text_len": len(e.get("text") or ""), "clipped": False}
    raise HTTPException(404, f"event {idx} not found in session {session_id}")


@lru_cache(maxsize=4)
def _read_jsonl_cached(path: str, mtime_ns: int) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                row = {}
            rows.append(row if isinstance(row, dict) else {})
    return rows


def _read_jsonl(p: Path) -> list[dict]:
    return _read_jsonl_cached(str(p), p.stat().st_mtime_ns)


@router.get("/judgments")
def get_judgments(path: str, session_id: str) -> dict:
    """Every row of the judgments file for this session (one per judge model),
    each tagged with its dataset row index."""
    p = safe_path(path)
    rows = [
        {**r, "__idx": i}
        for i, r in enumerate(_read_jsonl(p))
        if r.get("session_id") == session_id
    ]
    return {"rows": rows}


def _labels_file(dataset: Path) -> Path:
    return dataset.parent / LABELS_FILENAME


def _label_key(rec: dict) -> tuple:
    kind = rec.get("kind")
    if kind in ("incident", "considered"):
        return (kind, rec.get("session_id"), rec.get("judge_model"), rec.get(f"{kind}_idx"))
    return ("session", rec.get("session_id"))


def _latest_labels(dataset: Path, session_id: str | None) -> list[dict]:
    f = _labels_file(dataset)
    if not f.is_file():
        return []
    latest: dict[tuple, dict] = {}
    for rec in _read_jsonl(f):
        if session_id is not None and rec.get("session_id") != session_id:
            continue
        latest[_label_key(rec)] = rec
    return list(latest.values())


@router.get("/labels")
def get_labels(path: str, session_id: str | None = None) -> dict:
    """Current labels (the last line written per key wins)."""
    p = safe_path(path)
    return {"file": str(_labels_file(p)), "labels": _latest_labels(p, session_id)}


@router.post("/labels")
def add_label(payload: dict) -> dict:
    """Append one label line. `kind: "incident"` / `"considered"` (a close call
    the judge chose not to flag) are keyed by (session_id, judge_model,
    incident_idx / considered_idx); `kind: "session"` by session_id. The file
    name is recorded but is not part of the key: every judgments file in one
    directory (a run and its merged / augmented copies) shares the labels."""
    path, rec = payload.get("path"), payload.get("label")
    if not isinstance(path, str) or not isinstance(rec, dict):
        raise HTTPException(400, "expected {path, label: {...}}")
    p = safe_path(path)
    if rec.get("kind") not in ("incident", "considered", "session") or not isinstance(rec.get("session_id"), str):
        raise HTTPException(400, "label needs kind incident|considered|session and a session_id")
    line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "dataset": p.name, **rec}
    with _labels_file(p).open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
    return {"file": str(_labels_file(p)), "labels": _latest_labels(p, rec["session_id"])}


def _parse_firm(rule: str) -> list[tuple[str, float]]:
    """`"severity>=3,out_of_scope>=2"` → [("severity", 3), ("out_of_scope", 2)]."""
    out = []
    for part in rule.split(","):
        m = re.fullmatch(r"\s*(\w+)\s*>=\s*(-?\d+(?:\.\d+)?)\s*", part)
        if not m:
            raise HTTPException(400, f"firm rule must be comma-separated `field>=number` terms, got {part!r}")
        out.append((m.group(1), float(m.group(2))))
    return out


@router.get("/progress")
def label_progress(path: str, firm: str = "severity>=3,out_of_scope>=2") -> dict:
    """How much of the judgments file has a human label. An incident is "firm"
    (worth labelling first) when it meets every `field>=n` term of `firm`.
    The two `*_rows` lists are the dataset rows that still hold unlabelled
    (firm) incidents."""
    p = safe_path(path)
    terms = _parse_firm(firm)
    labelled = {
        (l.get("session_id"), l.get("judge_model"), l.get("incident_idx"))
        for l in _latest_labels(p, None)
        if l.get("kind") == "incident" and l.get("label")
    }
    total = {"incidents": 0, "labelled": 0, "firm": 0, "firm_labelled": 0}
    unlabelled_rows: list[int] = []
    unlabelled_firm_rows: list[int] = []
    for i, r in enumerate(_read_jsonl(p)):
        incidents = r.get("incidents") if isinstance(r.get("incidents"), list) else []
        open_any = open_firm = False
        for k, inc in enumerate(incidents):
            inc = inc if isinstance(inc, dict) else {}
            is_firm = all(isinstance(inc.get(key), (int, float)) and inc[key] >= n for key, n in terms)
            done = (r.get("session_id"), r.get("judge_model"), k) in labelled
            total["incidents"] += 1
            total["labelled"] += done
            total["firm"] += is_firm
            total["firm_labelled"] += is_firm and done
            open_any = open_any or not done
            open_firm = open_firm or (is_firm and not done)
        if open_any:
            unlabelled_rows.append(i)
        if open_firm:
            unlabelled_firm_rows.append(i)
    return {**total, "firm_rule": " and ".join(f"{k} ≥ {n:g}" for k, n in terms),
            "unlabelled_rows": unlabelled_rows, "unlabelled_firm_rows": unlabelled_firm_rows}
