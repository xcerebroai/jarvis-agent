"""Config resolution + generic project-index review for the desktop Realtime
voice feature.

Pure, dependency-light helpers — no FastAPI, no secrets, no network. The
`/api/audio/realtime/*` endpoints in ``web_server.py`` resolve the Hermes home /
profile scope and the standing OpenAI key, then call in here for everything that
is worth unit-testing on its own: the configurable voice identity and the
generic project-index review.

Design constraints (public distribution):
  * The default identity is the public product default — JARVIS, no personal
    user name, wake phrase "hey jarvis", Marin voice, a concise neutral
    delivery. Every value is overridable via ``config.yaml`` under
    ``voice.realtime.*`` — no new environment variables.
  * The optional ``review_projects`` fast path reads a *configured* local JSON
    index (``voice.realtime.review_projects.index_path``). There is NO built-in
    default path and NO assumption about the index's origin. When it is not
    configured (or the file is absent) the feature reports itself disabled and
    the renderer omits the tool entirely.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

# Public product defaults. Overridable per-operator via config.yaml.
REALTIME_DEFAULT_MODEL = "gpt-realtime-2.1"
REALTIME_DEFAULT_VOICE = "marin"
DEFAULT_ASSISTANT_NAME = "JARVIS"
DEFAULT_WAKE_PHRASE = "hey jarvis"
DEFAULT_DELIVERY = (
    "Use a clear, calm, and confident voice with a natural, neutral delivery. "
    "Keep it composed, precise, and subtly warm. Do not imitate a character or "
    "exaggerate an accent."
)

# Generic priority ordering for the review sort. Unknown priorities sort last.
_PRIORITY_RANK = {"urgent": 0, "high": 1, "normal": 2, "medium": 2, "low": 3}


def _voice_realtime_section(config: Dict[str, Any]) -> Dict[str, Any]:
    """The ``voice.realtime`` mapping from a loaded config.yaml (or empty)."""
    voice = config.get("voice") if isinstance(config, dict) else None
    section = voice.get("realtime") if isinstance(voice, dict) else None
    return section if isinstance(section, dict) else {}


def resolve_index_path(home: Path, config: Dict[str, Any]) -> Optional[Path]:
    """Absolute path to the configured project-index JSON, or None when unset.

    Relative paths resolve against the (profile-scoped) Hermes home so an
    operator can point at a file they keep alongside their config.
    """
    section = _voice_realtime_section(config)
    review = section.get("review_projects")
    review = review if isinstance(review, dict) else {}
    raw = str(review.get("index_path") or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = home / path
    return path


def review_enabled(home: Path, config: Dict[str, Any]) -> bool:
    """True only when an index is configured AND the file exists."""
    path = resolve_index_path(home, config)
    return bool(path and path.exists())


def _config_str(section: Dict[str, Any], key: str, default: str) -> str:
    value = section.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else default


def resolve_voice_config(home: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve the configurable voice identity to a JSON-safe dict (no secrets)."""
    section = _voice_realtime_section(config)
    greetings = section.get("greetings")
    greetings = [g for g in greetings if isinstance(g, str) and g.strip()] if isinstance(greetings, list) else []

    return {
        "ok": True,
        "enabled": section.get("enabled", True) is not False,
        "assistant_name": _config_str(section, "assistant_name", DEFAULT_ASSISTANT_NAME),
        # The user name defaults to empty (no personal name in the public build).
        "user_name": _config_str(section, "user_name", ""),
        "wake_phrase": _config_str(section, "wake_phrase", DEFAULT_WAKE_PHRASE),
        "auto_start": bool(section.get("auto_start", False)),
        "model": _config_str(section, "model", REALTIME_DEFAULT_MODEL),
        "voice": _config_str(section, "voice", REALTIME_DEFAULT_VOICE),
        "delivery": _config_str(section, "delivery", DEFAULT_DELIVERY),
        "greetings": greetings,
        "review_projects_enabled": review_enabled(home, config),
    }


def resolve_token_defaults(home: Path, config: Dict[str, Any]) -> Dict[str, str]:
    """The model/voice a token mint falls back to when the body omits them."""
    section = _voice_realtime_section(config)
    return {
        "model": _config_str(section, "model", REALTIME_DEFAULT_MODEL),
        "voice": _config_str(section, "voice", REALTIME_DEFAULT_VOICE),
    }


LOCAL_ADDITIONS_NAME = "local-additions.json"


def _local_additions_path(index_path: "Path") -> "Path":
    return index_path.parent / LOCAL_ADDITIONS_NAME


def read_local_additions(index_path: "Path") -> List[Dict[str, Any]]:
    """Voice-created projects live BESIDE the synced index, never inside it:
    the hourly sync overwrites the index file wholesale, so a write into it
    would not survive the next pull. The read path merges both."""
    try:
        import json as _json

        raw = _json.loads(_local_additions_path(index_path).read_text(encoding="utf-8"))
        rows = raw.get("projects") if isinstance(raw, dict) else raw
        return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
    except (OSError, ValueError):
        return []


def create_local_project(index_path: "Path", name: str, goal: str = "", tasks: Optional[List[str]] = None) -> Dict[str, Any]:
    """Durable minimal write path: append to local-additions.json atomically."""
    import json as _json
    import os as _os
    import tempfile as _tempfile

    name = (name or "").strip()[:120]
    if not name:
        raise ValueError("project name required")

    existing = read_local_additions(index_path)
    row = {
        "id": f"LP-{len(existing) + 1:03d}",
        "name": name,
        "status": "Planning",
        "priority": "Normal",
        "notes": (goal or "").strip()[:500],
        "nextAction": (tasks or [""])[0][:240] if tasks else "",
        "tasks": [{"done": False, "label": str(t)[:160]} for t in (tasks or [])[:12]],
        "source": "voice-intake",
    }
    existing.append(row)
    payload = _json.dumps({"projects": existing}, ensure_ascii=False, indent=2) + "\n"
    dest = _local_additions_path(index_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = _tempfile.mkstemp(prefix=".local-add-", suffix=".json", dir=str(dest.parent))
    try:
        with _os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        _os.replace(tmp, str(dest))
    finally:
        if _os.path.exists(tmp):
            _os.unlink(tmp)
    return row


def _project_rows(data: Any) -> List[Dict[str, Any]]:
    """Accept either a bare list of projects or ``{"projects": [...]}``."""
    projects = data.get("projects") if isinstance(data, dict) else data
    return [p for p in projects if isinstance(p, dict)] if isinstance(projects, list) else []


def _first(project: Dict[str, Any], *keys: str, default: str = "") -> Any:
    for key in keys:
        value = project.get(key)
        if value not in (None, ""):
            return value
    return default


def _index_updated(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    return str(meta.get("updated") or data.get("updated") or "")


def build_project_review(
    data: Any,
    query: Optional[str] = None,
    status_filter: Optional[str] = None,
    limit: int = 5,
    detail: bool = False,
) -> Dict[str, Any]:
    """Compact, deterministic review of a generic project index.

    Only status/priority/note/next-action/progress/target are surfaced; any
    other stored field (long descriptions, links, private notes) is left in the
    source untouched — hence ``detail_retained``.
    """
    query = (query or "").strip().lower()
    status_filter = (status_filter or "").strip().lower()
    limit = max(1, min(int(limit or 5), 8))

    rows: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}

    for project in _project_rows(data):
        status = str(_first(project, "status", default="?")) or "?"
        counts[status] = counts.get(status, 0) + 1
        tasks = project.get("tasks") if isinstance(project.get("tasks"), list) else []
        row = {
            "name": str(_first(project, "name", "project", "title", default="?")),
            "status": status,
            "priority": str(_first(project, "priority", default="Normal")),
            # Note is drawn only from explicit summary fields — never from a
            # free-form "notes"/"description" body, which stays out of the review.
            "note": str(_first(project, "note", "blocker", default=""))[:240],
            "next_action": str(_first(project, "next_action", "nextAction", default=""))[:240],
            "tasks_done": sum(1 for task in tasks if isinstance(task, dict) and task.get("done")),
            "tasks_total": len(tasks),
            "target_end": str(_first(project, "target_end", "targetEnd", default="")),
        }
        if detail:
            row.update({
                "build_type": str(_first(project, "buildType", "build_type", default="")),
                "client": str(_first(project, "client_name", "client", default="")),
                "company": str(_first(project, "company", default="")),
                "id": str(_first(project, "id", default="")),
                "notes": str(_first(project, "notes", "description", default=""))[:600],
                "owner": str(_first(project, "owner", default="")),
                "payment": str(_first(project, "payment", default="")),
                "start": str(_first(project, "start", default="")),
                "task_list": [
                    {"done": bool(task.get("done")), "label": str(task.get("label", ""))[:160]}
                    for task in tasks
                    if isinstance(task, dict)
                ],
            })
        haystack = " ".join(str(value).lower() for value in row.values())
        if query and query not in haystack:
            continue
        if status_filter and status.lower() != status_filter:
            continue
        rows.append(row)

    rows.sort(key=lambda row: (_PRIORITY_RANK.get(row["priority"].lower(), 9), row["name"].lower()))

    return {
        "ok": True,
        "source": "project index",
        "updated": _index_updated(data),
        "total_projects": sum(counts.values()),
        "status_counts": counts,
        "matches": len(rows),
        "projects": rows[:limit],
        "detail_retained": True,
    }
