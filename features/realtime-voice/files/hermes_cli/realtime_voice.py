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


def create_local_project(
    index_path: "Path",
    name: str,
    goal: str = "",
    tasks: Optional[List[str]] = None,
    source: str = "voice-intake",
    build_id: Optional[str] = None,
    status: str = "Planning",
) -> Dict[str, Any]:
    """Durable minimal write path: append to local-additions.json atomically.
    ``build_id`` links a board entry to its persistent build session."""
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
        "source": (source or "voice-intake")[:40],
    }
    if status and status != "Planning":
        row["status"] = str(status)[:40]
    if build_id:
        row["build_id"] = str(build_id)[:80]
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
    index_path: Optional["Path"] = None,
    today: Optional[str] = None,
) -> Dict[str, Any]:
    """Compact, deterministic review of a generic project index.

    P5.1: every row also carries the enriched schema — normalized priority,
    deadline (+days), staleness_days, revenue_relevance — with the owner's
    voice overrides (``local-overrides.json`` beside the index) applied. Pass
    ``index_path`` to enable the overrides + staleness ledger.

    Only status/priority/note/next-action/progress/target are surfaced; any
    other stored field (long descriptions, links, private notes) is left in the
    source untouched — hence ``detail_retained``.
    """
    query = (query or "").strip().lower()
    status_filter = (status_filter or "").strip().lower()
    limit = max(1, min(int(limit or 5), 8))

    rows: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}
    source_rows = _project_rows(data)
    overrides, ledger = load_enrichment(index_path, source_rows, today)

    for raw_project in source_rows:
        project = enrich_project(raw_project, overrides, ledger, today)
        status = str(_first(project, "status", default="?")) or "?"
        counts[status] = counts.get(status, 0) + 1
        tasks = project.get("tasks") if isinstance(project.get("tasks"), list) else []
        row = {
            "name": str(_first(project, "name", "project", "title", default="?")),
            "status": status,
            "priority": normalize_priority(_first(project, "priority", default="Normal")),
            # Note is drawn only from explicit summary fields — never from a
            # free-form "notes"/"description" body, which stays out of the review.
            "note": str(_first(project, "note", "blocker", default=""))[:240],
            "next_action": str(_first(project, "next_action", "nextAction", default=""))[:240],
            "tasks_done": sum(1 for task in tasks if isinstance(task, dict) and task.get("done")),
            "tasks_total": len(tasks),
            "target_end": str(_first(project, "target_end", "targetEnd", default="")),
            # P5.1 enriched schema (voice-editable via set_project_override)
            "deadline": project.get("deadline", ""),
            "days_to_deadline": project.get("days_to_deadline"),
            "staleness_days": project.get("staleness_days"),
            "revenue_relevance": project.get("revenue_relevance", "Unknown"),
            "revenue_outstanding": project.get("revenue_outstanding", 0),
            "overridden": project.get("overridden", []),
            "build_id": str(project.get("build_id") or ""),
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

    rows.sort(
        key=lambda row: (
            _PRIORITY_RANK.get(row["priority"].lower(), 9),
            row["days_to_deadline"] if isinstance(row.get("days_to_deadline"), int) else 10_000,
            row["name"].lower(),
        )
    )

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


def open_system_app(name: str) -> Dict[str, Any]:
    """Launch a desktop application by name for the voice `open_app` tool.

    No shell is involved — the name is passed as a single argv element to the
    platform launcher (`open -a` on macOS, `start` semantics via os.startfile
    on Windows), so it cannot be used for injection. A leading dash is refused
    because `open` would read it as a flag.
    """
    import subprocess
    import sys

    app = (name or "").strip()
    if not app or app.startswith("-") or "\x00" in app:
        return {"ok": False, "error": "invalid app name"}

    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["open", "-a", app], capture_output=True, text=True, timeout=15
            )
            if result.returncode != 0:
                message = (result.stderr or "").strip() or "application not found"
                return {"ok": False, "error": message}
            return {"ok": True}
        if sys.platform.startswith("win"):
            import os as _os

            _os.startfile(app)  # noqa: S606 - deliberate app launch  # type: ignore[attr-defined]
            return {"ok": True}
        result = subprocess.run(
            ["xdg-open", app], capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            return {"ok": False, "error": (result.stderr or "").strip() or "launch failed"}
        return {"ok": True}
    except Exception as exc:  # pragma: no cover - platform-dependent failures
        return {"ok": False, "error": str(exc)}


# =============================================================================
# P5.1 — PRIORITY REASONING: enriched index schema + voice-editable overrides
# =============================================================================
# The synced index is overwritten wholesale on every pull, so anything the
# owner says by voice ("mark Harris high priority") lives in a sidecar
# ``local-overrides.json`` beside the index and is merged on every read. The
# enrichment itself (normalized priority, deadline, staleness, revenue
# relevance) is computed on the read path from whatever the source carries,
# so it is correct even when the sync does not write those fields itself.

LOCAL_OVERRIDES_NAME = "local-overrides.json"
STALENESS_LEDGER_NAME = ".staleness-ledger.json"

# Fields the voice may set. Anything else is refused (never a free-form write).
OVERRIDE_FIELDS = ("priority", "deadline", "revenue_relevance", "note", "next_action", "status")

_PRIORITY_CANON = {
    "urgent": "Urgent", "critical": "Urgent", "top": "Urgent", "p0": "Urgent",
    "high": "High", "p1": "High", "important": "High",
    "normal": "Normal", "medium": "Normal", "default": "Normal", "p2": "Normal",
    "low": "Low", "p3": "Low", "later": "Low", "someday": "Low",
}
_REFERENCE_STOPWORDS = {"project", "projects", "the", "one", "that", "this", "build", "client", "for", "and", "with"}
_REVENUE_CANON = {"high": "High", "medium": "Medium", "med": "Medium", "low": "Low", "none": "Low", "unknown": "Unknown"}


def normalize_priority(value: Any) -> str:
    text = str(value or "").strip().lower()
    return _PRIORITY_CANON.get(text, "Normal" if not text else str(value).strip().title())


def normalize_revenue_relevance(value: Any) -> str:
    text = str(value or "").strip().lower()
    return _REVENUE_CANON.get(text, "Unknown" if not text else str(value).strip().title())


def _atomic_write_json(dest: "Path", payload: Any) -> None:
    import json as _json
    import os as _os
    import tempfile as _tempfile

    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = _tempfile.mkstemp(prefix=".rv-", suffix=".json", dir=str(dest.parent))
    try:
        with _os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(_json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        _os.replace(tmp, str(dest))
    finally:
        if _os.path.exists(tmp):
            _os.unlink(tmp)


def _read_json(path: "Path", default: Any) -> Any:
    try:
        import json as _json

        return _json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def project_key(project: Dict[str, Any]) -> str:
    """Stable per-project key: the source id when present, else the name."""
    pid = str(project.get("id") or "").strip()
    return pid if pid else str(_first(project, "name", "project", "title", default="")).strip().lower()


def read_local_overrides(index_path: "Path") -> Dict[str, Dict[str, Any]]:
    raw = _read_json(index_path.parent / LOCAL_OVERRIDES_NAME, {})
    rows = raw.get("overrides") if isinstance(raw, dict) else None
    return {str(k): v for k, v in rows.items() if isinstance(v, dict)} if isinstance(rows, dict) else {}


def resolve_project(rows: List[Dict[str, Any]], reference: str) -> Optional[Dict[str, Any]]:
    """Match a spoken reference to one project: exact id, exact name, then a
    unique substring / token match. Returns None when nothing (or more than
    one thing) matches — the caller asks aloud rather than guessing."""
    ref = (reference or "").strip().lower()
    if not ref:
        return None
    names = [(project, str(_first(project, "name", "project", "title", default="")).strip()) for project in rows]
    for project, name in names:
        if str(project.get("id") or "").strip().lower() == ref or name.lower() == ref:
            return project
    partial = [project for project, name in names if ref in name.lower()]
    if len(partial) == 1:
        return partial[0]
    # The owner often names the CLIENT ("mark Harris high priority"): a unique
    # client/company match counts too.
    if not partial:
        by_client = [
            project for project, _name in names
            if ref in str(_first(project, "client_name", "client", "company", default="")).lower()
        ]
        if len(by_client) == 1:
            return by_client[0]
    # Token match, strict: every meaningful token of the reference must appear
    # in the name (generic words like "project" never count), and the match
    # must be unique. A spoken "zzz project" must NOT land on some real project.
    tokens = [t for t in ref.replace("-", " ").split() if len(t) > 2 and t not in _REFERENCE_STOPWORDS]
    if tokens:
        full = [project for project, name in names if all(t in name.lower() for t in tokens)]
        if len(full) == 1:
            return full[0]
    return None


def set_project_override(index_path: "Path", rows: List[Dict[str, Any]], reference: str, fields: Dict[str, Any]) -> Dict[str, Any]:
    """Voice edit: persist allowed fields for one resolved project. Raises
    ValueError on an unresolvable reference or a disallowed field."""
    import datetime as _dt

    project = resolve_project(rows, reference)
    if project is None:
        raise ValueError(f"no single project matches '{reference}'")
    clean: Dict[str, Any] = {}
    for key, value in (fields or {}).items():
        if key not in OVERRIDE_FIELDS:
            raise ValueError(f"field '{key}' is not voice-editable")
        text = str(value or "").strip()
        if not text:
            continue
        if key == "priority":
            text = normalize_priority(text)
        elif key == "revenue_relevance":
            text = normalize_revenue_relevance(text)
        clean[key] = text[:240]
    if not clean:
        raise ValueError("no field values given")
    key = project_key(project)
    overrides = read_local_overrides(index_path)
    current = dict(overrides.get(key) or {})
    current.update(clean)
    current["updated"] = _dt.datetime.now().replace(microsecond=0).isoformat()
    current["name"] = str(_first(project, "name", "project", "title", default=""))
    overrides[key] = current
    _atomic_write_json(index_path.parent / LOCAL_OVERRIDES_NAME, {"overrides": overrides})
    return {"key": key, "name": current["name"], "fields": clean}


def _fingerprint(project: Dict[str, Any]) -> str:
    import hashlib as _hashlib
    import json as _json

    material = {
        "status": project.get("status"),
        "tasks": project.get("tasks"),
        "next": _first(project, "next_action", "nextAction", default=""),
        "blocker": _first(project, "note", "blocker", default=""),
        "notes": _first(project, "notes", "description", default=""),
        "payment": project.get("payment"),
        "target": _first(project, "target_end", "targetEnd", "deadline", default=""),
    }
    return _hashlib.sha1(_json.dumps(material, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def update_staleness_ledger(index_path: "Path", rows: List[Dict[str, Any]], now: Optional[str] = None) -> Dict[str, Dict[str, str]]:
    """Staleness = days since a project's content last changed. The source has
    no per-project timestamp, so the read path keeps a fingerprint ledger and
    dates each change itself. First sighting counts from the day it was seen."""
    import datetime as _dt

    stamp = now or _dt.date.today().isoformat()
    ledger_path = index_path.parent / STALENESS_LEDGER_NAME
    ledger = _read_json(ledger_path, {})
    ledger = ledger if isinstance(ledger, dict) else {}
    changed = False
    for project in rows:
        key = project_key(project)
        if not key:
            continue
        fp = _fingerprint(project)
        entry = ledger.get(key)
        if not isinstance(entry, dict) or entry.get("fp") != fp:
            ledger[key] = {"fp": fp, "changed_at": stamp}
            changed = True
    if changed:
        try:
            _atomic_write_json(ledger_path, ledger)
        except OSError:
            pass
    return ledger


def _days_between(later: str, earlier: str) -> Optional[int]:
    import datetime as _dt

    try:
        a = _dt.date.fromisoformat(str(later)[:10])
        b = _dt.date.fromisoformat(str(earlier)[:10])
    except ValueError:
        return None
    return (a - b).days


def _derive_revenue(project: Dict[str, Any]) -> Dict[str, Any]:
    payment = project.get("payment") if isinstance(project.get("payment"), dict) else {}
    try:
        total = float(payment.get("total") or 0)
        paid = float(payment.get("paid") or 0)
    except (TypeError, ValueError):
        total, paid = 0.0, 0.0
    outstanding = max(0.0, total - paid)
    pay_status = str(payment.get("status") or "").strip().lower()
    status = str(project.get("status") or "").strip().lower()
    if status == "payment follow-up" or pay_status in ("overdue", "unpaid", "pending", "follow-up", "partial"):
        relevance = "High"
    elif outstanding >= 1000:
        relevance = "High"
    elif outstanding > 0:
        relevance = "Medium"
    elif total > 0:
        relevance = "Low"  # paid in full — no money at stake right now
    else:
        relevance = "Unknown"
    return {"revenue_relevance": relevance, "revenue_outstanding": round(outstanding, 2), "revenue_total": round(total, 2)}


def enrich_project(project: Dict[str, Any], overrides: Dict[str, Dict[str, Any]], ledger: Dict[str, Dict[str, str]], today: Optional[str] = None) -> Dict[str, Any]:
    """The enriched schema for one project: normalized priority, deadline,
    days_to_deadline, staleness_days, revenue relevance — with voice overrides
    applied on top of whatever the source or the sync wrote."""
    import datetime as _dt

    stamp = today or _dt.date.today().isoformat()
    key = project_key(project)
    override = overrides.get(key) or {}
    merged = dict(project)
    for field in OVERRIDE_FIELDS:
        if override.get(field):
            merged[field] = override[field]
    deadline = str(_first(merged, "deadline", "target_end", "targetEnd", default="")).strip()[:10]
    revenue = _derive_revenue(merged)
    if override.get("revenue_relevance"):
        revenue["revenue_relevance"] = normalize_revenue_relevance(override["revenue_relevance"])
    changed_at = (ledger.get(key) or {}).get("changed_at") if key else None
    enriched = {
        "priority": normalize_priority(_first(merged, "priority", default="Normal")),
        "deadline": deadline,
        "days_to_deadline": _days_between(deadline, stamp) if deadline else None,
        "staleness_days": _days_between(stamp, changed_at) if changed_at else None,
        "overridden": sorted(k for k in OVERRIDE_FIELDS if override.get(k)),
        **revenue,
    }
    return {**merged, **enriched}


def load_enrichment(index_path: Optional["Path"], rows: List[Dict[str, Any]], today: Optional[str] = None):
    """(overrides, ledger) for an index path; empty when no index is configured."""
    if index_path is None:
        return {}, {}
    return read_local_overrides(index_path), update_staleness_ledger(index_path, rows, today)


_REASONING_MAX_ROWS = 80


def build_reasoning_context(data: Any, index_path: Optional["Path"] = None, today: Optional[str] = None) -> Dict[str, Any]:
    """The full enriched board, compact, for the judgment bridge to the full
    agent. One line per project — the model ranks; this only informs."""
    rows = _project_rows(data)
    overrides, ledger = load_enrichment(index_path, rows, today)
    lines: List[str] = []
    projects: List[Dict[str, Any]] = []
    for project in rows[:_REASONING_MAX_ROWS]:
        e = enrich_project(project, overrides, ledger, today)
        tasks = e.get("tasks") if isinstance(e.get("tasks"), list) else []
        done = sum(1 for t in tasks if isinstance(t, dict) and t.get("done"))
        name = str(_first(e, "name", "project", "title", default="?"))
        compact = {
            "name": name,
            "status": str(e.get("status") or "?"),
            "priority": e["priority"],
            "deadline": e["deadline"],
            "days_to_deadline": e["days_to_deadline"],
            "staleness_days": e["staleness_days"],
            "revenue_relevance": e["revenue_relevance"],
            "revenue_outstanding": e["revenue_outstanding"],
            "tasks": f"{done}/{len(tasks)}",
            "blocker": str(_first(e, "note", "blocker", default=""))[:140],
            "next_action": str(_first(e, "next_action", "nextAction", default=""))[:140],
            "client": str(_first(e, "client_name", "client", "company", default=""))[:60],
        }
        projects.append(compact)
        bits = [
            f"{name} [{compact['status']}, {compact['priority']} priority",
            f"deadline {compact['deadline'] or 'none'}" + (f" ({compact['days_to_deadline']:+d}d)" if compact["days_to_deadline"] is not None else ""),
            f"stale {compact['staleness_days']}d" if compact["staleness_days"] is not None else "stale ?",
            f"revenue {compact['revenue_relevance']}" + (f" ${compact['revenue_outstanding']:.0f} outstanding" if compact["revenue_outstanding"] else ""),
            f"tasks {compact['tasks']}]",
        ]
        line = ", ".join(bits)
        if compact["blocker"]:
            line += f" blocker: {compact['blocker']}"
        if compact["next_action"]:
            line += f" next: {compact['next_action']}"
        lines.append(line)
    return {
        "ok": True,
        "updated": _index_updated(data),
        "today": today or __import__("datetime").date.today().isoformat(),
        "total_projects": len(rows),
        "truncated": max(0, len(rows) - _REASONING_MAX_ROWS),
        "projects": projects,
        "text": "\n".join(lines),
    }


# =============================================================================
# P5.1 — SIGHT: on-demand screen capture → vision model, with honest accounting
# =============================================================================
# macOS capture uses the system `screencapture` (argv-only), gated by the
# Screen Recording TCC check (CGPreflightScreenCaptureAccess). Without the
# grant macOS silently returns a wallpaper-only frame, so the preflight is
# what makes the permission flow truthful: not granted → request the grant,
# open the Settings pane, and tell the voice layer instead of "seeing" nothing.

SIGHT_DEFAULT_MODEL = "gpt-4.1-mini"
SIGHT_DEFAULT_MAX_EDGE = 1600
# Published list prices, USD per 1M tokens (input, output), for the estimate.
# The estimate is labelled as such; it is never presented as a billed amount.
SIGHT_LIST_PRICES_PER_M = {
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-5-nano": (0.05, 0.40),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5": (1.25, 10.00),
}
_SIGHT_SYSTEM_PROMPT = (
    "You are the vision core of a desktop voice assistant. You are shown one "
    "screenshot of the user's screen. Answer the question about what is "
    "visible, concretely and briefly (under 90 words), in plain spoken prose: "
    "name the apps/windows, the key text, numbers, and any errors. If the "
    "question is empty, describe what the user is looking at and anything that "
    "needs attention. Never guess at content that is not visible."
)


def resolve_sight_config(config: Dict[str, Any]) -> Dict[str, Any]:
    section = _voice_realtime_section(config)
    sight = section.get("sight") if isinstance(section.get("sight"), dict) else {}
    try:
        max_edge = int(sight.get("max_edge") or SIGHT_DEFAULT_MAX_EDGE)
    except (TypeError, ValueError):
        max_edge = SIGHT_DEFAULT_MAX_EDGE
    return {
        "enabled": sight.get("enabled", True) is not False,
        "model": _config_str(sight, "model", SIGHT_DEFAULT_MODEL),
        "max_edge": max(640, min(max_edge, 3200)),
        "detail": _config_str(sight, "detail", "auto"),
    }


def estimate_cost_usd(model: str, usage: Optional[Dict[str, Any]]) -> Optional[float]:
    """List-price estimate from a usage block; None when the model is unpriced."""
    prices = SIGHT_LIST_PRICES_PER_M.get((model or "").strip().lower())
    if not prices or not isinstance(usage, dict):
        return None
    try:
        prompt_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        completion_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    except (TypeError, ValueError):
        return None
    return round((prompt_tokens * prices[0] + completion_tokens * prices[1]) / 1_000_000, 6)


def screen_capture_access() -> Dict[str, Any]:
    """macOS Screen Recording grant state for THIS process (TCC attributes a
    spawned `screencapture` to the responsible app — the desktop bundle)."""
    import sys

    if sys.platform != "darwin":
        return {"platform": sys.platform, "granted": True, "checked": False}
    try:
        import ctypes

        cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cg.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        return {"platform": "darwin", "granted": bool(cg.CGPreflightScreenCaptureAccess()), "checked": True}
    except Exception as exc:  # pragma: no cover - CoreGraphics missing
        return {"platform": "darwin", "granted": False, "checked": False, "error": str(exc)}


def request_screen_capture_access() -> bool:
    """Ask macOS for the Screen Recording grant (system dialog, once per app)
    and open the Privacy pane so the owner can flip the switch. Returns the
    grant state after the request (usually still False until the toggle)."""
    import subprocess
    import sys

    if sys.platform != "darwin":
        return True
    granted = False
    try:
        import ctypes

        cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cg.CGRequestScreenCaptureAccess.restype = ctypes.c_bool
        granted = bool(cg.CGRequestScreenCaptureAccess())
    except Exception:
        granted = False
    if not granted:
        try:
            subprocess.run(
                ["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
    return granted


# --- Sight SCOPE: "my screen" means the OWNER's screen, never our own window.
# CoreGraphics via ctypes (no pyobjc in the install): enumerate on-screen
# windows front-to-back, drop our own app's windows (owner PID = the desktop
# process that spawned this gateway, plus the product's owner names) and
# system chrome, and capture the frontmost remaining WINDOW (`screencapture
# -l` reads a window's own backing store, so our HUD sitting on top of it does
# not leak in). Only when no candidate window exists do we fall back to the
# full display under the pointer — reported honestly as possibly including us.

SELF_OWNER_NAMES = {"jarvis", "hermes", "hermes helper", "hermes helper (renderer)"}
_SYSTEM_OWNERS = {
    "window server", "dock", "control center", "notification center", "systemuiserver",
    "spotlight", "screenshot", "wallpaper", "textinputmenuagent", "coreservicesuiagent",
}
_MIN_WINDOW_EDGE = 120
_UTF8 = 0x08000100


def _coregraphics():
    """Lazily bound CoreFoundation/CoreGraphics handles (macOS only)."""
    import ctypes
    import sys

    if sys.platform != "darwin":
        return None
    try:
        cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    except OSError:
        return None

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    class CGSize(ctypes.Structure):
        _fields_ = [("w", ctypes.c_double), ("h", ctypes.c_double)]

    class CGRect(ctypes.Structure):
        _fields_ = [("origin", CGPoint), ("size", CGSize)]

    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    cf.CFDictionaryGetValue.restype = ctypes.c_void_p
    cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cf.CFNumberGetValue.restype = ctypes.c_bool
    cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
    cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    cg.CGRectMakeWithDictionaryRepresentation.restype = ctypes.c_bool
    cg.CGRectMakeWithDictionaryRepresentation.argtypes = [ctypes.c_void_p, ctypes.POINTER(CGRect)]
    cg.CGEventCreate.restype = ctypes.c_void_p
    cg.CGEventCreate.argtypes = [ctypes.c_void_p]
    cg.CGEventGetLocation.restype = CGPoint
    cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
    cg.CGGetActiveDisplayList.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
    cg.CGDisplayBounds.restype = CGRect
    cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
    cg.CGMainDisplayID.restype = ctypes.c_uint32
    return {"cf": cf, "cg": cg, "CGRect": CGRect, "ctypes": ctypes}


def list_windows() -> List[Dict[str, Any]]:
    """On-screen, layer-0 windows, front-to-back: owner, pid, id, title, bounds."""
    api = _coregraphics()
    if not api:
        return []
    cf, cg, CGRect, ctypes = api["cf"], api["cg"], api["CGRect"], api["ctypes"]

    def key(name: str):
        return cf.CFStringCreateWithCString(None, name.encode("utf-8"), _UTF8)

    def number(d, k) -> Optional[int]:
        v = cf.CFDictionaryGetValue(d, k)
        if not v:
            return None
        out = ctypes.c_int64()
        return int(out.value) if cf.CFNumberGetValue(v, 4, ctypes.byref(out)) else None  # kCFNumberSInt64Type

    def text(d, k) -> str:
        v = cf.CFDictionaryGetValue(d, k)
        if not v:
            return ""
        buf = ctypes.create_string_buffer(1024)
        return buf.value.decode("utf-8", "replace") if cf.CFStringGetCString(v, buf, 1024, _UTF8) else ""

    keys = {n: key(n) for n in ("kCGWindowLayer", "kCGWindowOwnerName", "kCGWindowOwnerPID", "kCGWindowNumber", "kCGWindowName", "kCGWindowBounds", "kCGWindowAlpha")}
    rows: List[Dict[str, Any]] = []
    arr = cg.CGWindowListCopyWindowInfo(1 | 16, 0)  # kCGWindowListOptionOnScreenOnly | ExcludeDesktopElements
    if not arr:
        return rows
    try:
        for i in range(cf.CFArrayGetCount(arr)):
            d = cf.CFArrayGetValueAtIndex(arr, i)
            if number(d, keys["kCGWindowLayer"]) != 0:
                continue
            rect = CGRect()
            bounds_ref = cf.CFDictionaryGetValue(d, keys["kCGWindowBounds"])
            if not bounds_ref or not cg.CGRectMakeWithDictionaryRepresentation(bounds_ref, ctypes.byref(rect)):
                continue
            rows.append({
                "owner": text(d, keys["kCGWindowOwnerName"]),
                "pid": number(d, keys["kCGWindowOwnerPID"]) or 0,
                "id": number(d, keys["kCGWindowNumber"]) or 0,
                "title": text(d, keys["kCGWindowName"]),
                "bounds": (rect.origin.x, rect.origin.y, rect.size.w, rect.size.h),
            })
    finally:
        cf.CFRelease(arr)
        for k in keys.values():
            cf.CFRelease(k)
    return rows


def list_displays() -> List[Dict[str, Any]]:
    api = _coregraphics()
    if not api:
        return []
    cg, ctypes = api["cg"], api["ctypes"]
    ids = (ctypes.c_uint32 * 16)()
    count = ctypes.c_uint32()
    cg.CGGetActiveDisplayList(16, ids, ctypes.byref(count))
    main = cg.CGMainDisplayID()
    out = []
    for i in range(count.value):
        r = cg.CGDisplayBounds(ids[i])
        out.append({"id": int(ids[i]), "index": i + 1, "main": int(ids[i]) == int(main), "bounds": (r.origin.x, r.origin.y, r.size.w, r.size.h)})
    return out


def pointer_location() -> Optional[tuple]:
    api = _coregraphics()
    if not api:
        return None
    cg = api["cg"]
    event = cg.CGEventCreate(None)
    if not event:
        return None
    try:
        p = cg.CGEventGetLocation(event)
        return (p.x, p.y)
    finally:
        api["cf"].CFRelease(event)


def self_window_pids() -> set:
    """The desktop process that spawned this gateway owns our windows."""
    import os as _os

    return {_os.getppid()}


def _contains(bounds, x, y) -> bool:
    bx, by, bw, bh = bounds
    return bx <= x < bx + bw and by <= y < by + bh


def _display_for(displays, bounds_or_point) -> Optional[Dict[str, Any]]:
    if not displays:
        return None
    if len(bounds_or_point) == 4:
        bx, by, bw, bh = bounds_or_point
        x, y = bx + bw / 2, by + bh / 2
    else:
        x, y = bounds_or_point
    for d in displays:
        if _contains(d["bounds"], x, y):
            return d
    return next((d for d in displays if d.get("main")), displays[0])


def select_capture_target(
    windows: List[Dict[str, Any]],
    displays: List[Dict[str, Any]],
    pointer: Optional[tuple],
    self_pids: set,
    app: Optional[str] = None,
    self_names: Optional[set] = None,
) -> Dict[str, Any]:
    """Pure decision: WHAT to capture. Never our own window; the owner's."""
    self_names = {n.lower() for n in (self_names if self_names is not None else SELF_OWNER_NAMES)}

    def is_self(w) -> bool:
        return w.get("pid") in self_pids or str(w.get("owner", "")).strip().lower() in self_names

    def is_real(w) -> bool:
        _x, _y, bw, bh = w.get("bounds") or (0, 0, 0, 0)
        return bw >= _MIN_WINDOW_EDGE and bh >= _MIN_WINDOW_EDGE and str(w.get("owner", "")).strip().lower() not in _SYSTEM_OWNERS

    def as_window(w, reason: str) -> Dict[str, Any]:
        display = _display_for(displays, w["bounds"])
        return {
            "kind": "window", "window_id": int(w["id"]), "app": w.get("owner", ""), "title": w.get("title", ""),
            "bounds": list(w["bounds"]), "display_index": display["index"] if display else 1, "reason": reason, "includes_self": False,
        }

    wanted = (app or "").strip().lower()
    if wanted:
        if any(wanted in name or name in wanted for name in self_names):
            return {"kind": "none", "error": "that is JARVIS's own window — say which app to look at instead", "app": app}
        usable = [w for w in windows if is_real(w) and not is_self(w)]
        # App (owner) name first; a window-title fragment only when no app matches.
        matches = [w for w in usable if wanted in str(w.get("owner", "")).lower()] or [w for w in usable if wanted in str(w.get("title", "")).lower()]
        if not matches:
            return {"kind": "none", "error": f"no visible window for '{app}'", "app": app}
        return as_window(matches[0], f"requested app '{app}'")

    candidates = [w for w in windows if is_real(w) and not is_self(w)]
    first_real = next((w for w in windows if is_real(w) or is_self(w)), None)
    we_are_frontmost = first_real is not None and is_self(first_real)
    if candidates:
        return as_window(candidates[0], "frontmost window behind JARVIS" if we_are_frontmost else "frontmost window")

    display = _display_for(displays, pointer) if pointer else (next((d for d in displays if d.get("main")), displays[0]) if displays else None)
    if not display:
        return {"kind": "display", "display_index": 1, "bounds": None, "reason": "no window list available", "includes_self": we_are_frontmost}
    return {"kind": "display", "display_index": display["index"], "bounds": list(display["bounds"]), "reason": "no other window on screen; display under the pointer", "includes_self": we_are_frontmost}


def resolve_capture_target(app: Optional[str] = None) -> Dict[str, Any]:
    """Live selection on this machine (macOS); a plain display elsewhere."""
    import sys

    if sys.platform != "darwin":
        return {"kind": "display", "display_index": 1, "bounds": None, "reason": "platform default", "includes_self": False}
    try:
        return select_capture_target(list_windows(), list_displays(), pointer_location(), self_window_pids(), app=app)
    except Exception as exc:  # pragma: no cover - CoreGraphics oddities never block a look
        return {"kind": "display", "display_index": 1, "bounds": None, "reason": f"window list failed: {exc.__class__.__name__}", "includes_self": False}


def capture_screen(dest_dir: "Path", max_edge: int = SIGHT_DEFAULT_MAX_EDGE, target: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Grab the target (a window by id, or a display region) to a JPEG under
    dest_dir, downscaled to max_edge. argv-only subprocesses; nothing
    shell-interpolated. No target → the main display."""
    import subprocess
    import sys
    import time

    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / "last-look.jpg"
    started = time.monotonic()
    try:
        if sys.platform == "darwin":
            argv = ["screencapture", "-x", "-t", "jpg"]
            if target and target.get("kind") == "window" and target.get("window_id"):
                argv += ["-o", "-l", str(int(target["window_id"]))]
            elif target and target.get("kind") == "display" and target.get("bounds"):
                bx, by, bw, bh = target["bounds"]
                argv += ["-R", f"{int(bx)},{int(by)},{int(bw)},{int(bh)}"]
            result = subprocess.run(argv + [str(path)], capture_output=True, text=True, timeout=20)
            if result.returncode != 0 or not path.exists():
                return {"ok": False, "error": (result.stderr or "").strip() or "screencapture failed"}
            subprocess.run(["sips", "-Z", str(int(max_edge)), str(path)], capture_output=True, text=True, timeout=20)
            dims = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)], capture_output=True, text=True, timeout=20)
            width = height = 0
            for line in (dims.stdout or "").splitlines():
                if "pixelWidth" in line:
                    width = int(line.split(":")[-1].strip() or 0)
                elif "pixelHeight" in line:
                    height = int(line.split(":")[-1].strip() or 0)
        elif sys.platform.startswith("win"):
            script = (
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
                "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
                "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
                "$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);"
                "$bmp.Save($args[0],[System.Drawing.Imaging.ImageFormat]::Jpeg);Write-Output \"$($b.Width)x$($b.Height)\""
            )
            result = subprocess.run(["powershell", "-NoProfile", "-Command", script, str(path)], capture_output=True, text=True, timeout=30)
            if result.returncode != 0 or not path.exists():
                return {"ok": False, "error": (result.stderr or "").strip() or "screen capture failed"}
            try:
                width, height = (int(v) for v in (result.stdout or "0x0").strip().split("x"))
            except ValueError:
                width = height = 0
        else:
            return {"ok": False, "error": f"screen capture is not supported on {sys.platform}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "path": str(path),
        "width": width,
        "height": height,
        "bytes": path.stat().st_size,
        "capture_ms": int((time.monotonic() - started) * 1000),
    }


def analyze_screen_image(path: "Path", question: str, api_key: str, model: str = SIGHT_DEFAULT_MODEL, detail: str = "auto", timeout_s: int = 60) -> Dict[str, Any]:
    """One vision call against OpenAI chat completions with the JPEG inlined.
    Returns the answer plus the provider's usage block, the wall-clock latency,
    and a list-price cost estimate — the numbers the voice reports honestly."""
    import base64
    import json as _json
    import time
    import urllib.error
    import urllib.request

    started = time.monotonic()
    try:
        data = base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError as exc:
        return {"ok": False, "error": f"could not read capture: {exc}"}
    prompt = (question or "").strip() or "Describe what is on screen and anything that needs attention."
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SIGHT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{data}", "detail": detail or "auto"}},
                ],
            },
        ],
        "max_completion_tokens": 400,
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=_json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            payload = _json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"vision model rejected the request (HTTP {exc.code})", "latency_ms": int((time.monotonic() - started) * 1000)}
    except Exception as exc:
        return {"ok": False, "error": f"vision call failed: {exc.__class__.__name__}", "latency_ms": int((time.monotonic() - started) * 1000)}
    latency_ms = int((time.monotonic() - started) * 1000)
    answer = ""
    try:
        answer = str(payload["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        answer = ""
    usage = payload.get("usage") if isinstance(payload, dict) and isinstance(payload.get("usage"), dict) else None
    return {
        "ok": bool(answer),
        "answer": answer,
        "error": None if answer else "the vision model returned no answer",
        "model": str(payload.get("model") or model) if isinstance(payload, dict) else model,
        "usage": {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens")} if usage else None,
        "latency_ms": latency_ms,
        "cost_usd": estimate_cost_usd(model, usage),
        "cost_basis": "list-price estimate" if estimate_cost_usd(model, usage) is not None else "unpriced model",
    }


def _thumbnail_data_url(path: "Path", max_edge: int = 480) -> str:
    """Small JPEG data URL of a capture for the cockpit plate (macOS sips;
    empty string elsewhere or on failure — the plate simply omits it)."""
    import base64
    import subprocess
    import sys

    try:
        if sys.platform != "darwin":
            return ""
        thumb = path.with_name("last-look-thumb.jpg")
        subprocess.run(["sips", "-Z", str(max_edge), str(path), "--out", str(thumb)], capture_output=True, text=True, timeout=20)
        if not thumb.exists() or thumb.stat().st_size > 400_000:
            return ""
        return "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode("ascii")
    except Exception:
        return ""


def _append_look_log(home: "Path", entry: Dict[str, Any]) -> None:
    import json as _json

    try:
        log_dir = home / "cache" / "sight"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "looks.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(_json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def look_at_screen(home: "Path", config: Dict[str, Any], api_key: str, question: str = "", app: Optional[str] = None) -> Dict[str, Any]:
    """The whole look: permission gate → target (never our own window) →
    capture → vision → accounting. ``app`` = "look at <app>"."""
    import datetime as _dt
    import time

    sight = resolve_sight_config(config)
    if not sight["enabled"]:
        return {"ok": False, "error": "sight is disabled in config (voice.realtime.sight.enabled)"}
    if not api_key:
        return {"ok": False, "error": "no OpenAI key for the vision model (VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY)"}
    access = screen_capture_access()
    if not access.get("granted"):
        granted_now = request_screen_capture_access()
        if not granted_now:
            return {"ok": False, "permission": "requested", "error": "Screen Recording permission is not granted"}
    started = time.monotonic()
    target = resolve_capture_target(app)
    if target.get("kind") == "none":
        return {"ok": False, "error": target.get("error") or "nothing to capture", "target": target}
    capture = capture_screen(home / "cache" / "sight", sight["max_edge"], target)
    if not capture.get("ok"):
        return {"ok": False, "error": capture.get("error") or "capture failed", "target": target}
    scoped_question = (question or "").strip()
    if target.get("kind") == "window" and target.get("app"):
        scoped_question = f"(The screenshot is the window of {target['app']}{' — ' + target['title'] if target.get('title') else ''}.) " + (scoped_question or "Describe what is shown and anything that needs attention.")
    analysis = analyze_screen_image(Path(capture["path"]), scoped_question, api_key, sight["model"], sight["detail"])
    total_ms = int((time.monotonic() - started) * 1000)
    result = {
        "ok": bool(analysis.get("ok")),
        "answer": analysis.get("answer") or "",
        "error": analysis.get("error"),
        "question": (question or "").strip(),
        "model": analysis.get("model") or sight["model"],
        "usage": analysis.get("usage"),
        "cost_usd": analysis.get("cost_usd"),
        "cost_basis": analysis.get("cost_basis"),
        "latency_ms": total_ms,
        "capture_ms": capture.get("capture_ms"),
        "analyze_ms": analysis.get("latency_ms"),
        "width": capture.get("width"),
        "height": capture.get("height"),
        "bytes": capture.get("bytes"),
        "image_path": capture.get("path"),
        "target": target,
        "thumbnail": _thumbnail_data_url(Path(capture["path"])),
        "at": _dt.datetime.now().replace(microsecond=0).isoformat(),
    }
    _append_look_log(home, {k: v for k, v in result.items() if k != "thumbnail"})
    return result


def thumbnail_for_path(home: "Path", raw_path: str, max_edge: int = 480) -> Dict[str, Any]:
    """Cockpit thumbnail of an agent-produced screenshot. Confined to image
    files under the Hermes home (where the browser tool keeps screenshots)."""
    import os as _os

    candidate = Path(str(raw_path or "").strip()).expanduser()
    try:
        resolved = candidate.resolve()
        root = home.resolve()
    except OSError:
        return {"ok": False, "error": "bad path"}
    if _os.path.commonpath([str(resolved), str(root)]) != str(root):
        return {"ok": False, "error": "path is outside the Hermes home"}
    if resolved.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp") or not resolved.is_file():
        return {"ok": False, "error": "not an image file"}
    data_url = _thumbnail_data_url(resolved, max_edge)
    return {"ok": bool(data_url), "thumbnail": data_url, "path": str(resolved)}


# =============================================================================
# P5.1 — BUILD SESSIONS: the persistent registry (survives app restarts)
# =============================================================================
# A build is a real named agent session plus this durable record. The desktop
# creates the session over the gateway, registers it here, and re-reads the
# registry on launch to pin the cockpit plates and route "how's X going?".

BUILDS_FILE = "builds/sessions.json"
BUILD_STATES = ("planning", "working", "waiting", "done", "failed", "idle")


def _builds_path(home: "Path") -> "Path":
    return home / BUILDS_FILE


def list_builds(home: "Path") -> List[Dict[str, Any]]:
    raw = _read_json(_builds_path(home), {})
    rows = raw.get("builds") if isinstance(raw, dict) else None
    return [r for r in rows if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []


def _write_builds(home: "Path", rows: List[Dict[str, Any]]) -> None:
    _atomic_write_json(_builds_path(home), {"builds": rows})


def upsert_build(home: "Path", build: Dict[str, Any]) -> Dict[str, Any]:
    import datetime as _dt

    build_id = str(build.get("id") or "").strip()
    name = str(build.get("name") or "").strip()[:120]
    goal = str(build.get("goal") or "").strip()[:2000]
    if not build_id or not name or not goal:
        raise ValueError("build id, name and goal are required")
    now = _dt.datetime.now().replace(microsecond=0).isoformat()
    rows = list_builds(home)
    existing = next((r for r in rows if r.get("id") == build_id), None)
    record = {
        **(existing or {"created_at": now}),
        "id": build_id,
        "name": name,
        "goal": goal,
        "state": str(build.get("state") or (existing or {}).get("state") or "planning"),
        "session_id": build.get("session_id") or (existing or {}).get("session_id"),
        "stored_session_id": build.get("stored_session_id") or (existing or {}).get("stored_session_id"),
        "project_id": build.get("project_id") or (existing or {}).get("project_id"),
        "last_summary": str(build.get("last_summary") or (existing or {}).get("last_summary") or "")[:1200],
        "updated_at": now,
    }
    if record["state"] not in BUILD_STATES:
        record["state"] = "planning"
    if existing is None:
        rows.append(record)
    else:
        rows[rows.index(existing)] = record
    _write_builds(home, rows)
    return record


def update_build(home: "Path", build_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    import datetime as _dt

    rows = list_builds(home)
    for index, row in enumerate(rows):
        if row.get("id") == build_id:
            allowed = {k: v for k, v in (patch or {}).items() if k in ("state", "session_id", "stored_session_id", "project_id", "last_summary", "name")}
            if "state" in allowed and allowed["state"] not in BUILD_STATES:
                allowed.pop("state")
            if "last_summary" in allowed:
                allowed["last_summary"] = str(allowed["last_summary"] or "")[:1200]
            rows[index] = {**row, **allowed, "updated_at": _dt.datetime.now().replace(microsecond=0).isoformat()}
            _write_builds(home, rows)
            return rows[index]
    return None


# =============================================================================
# P6.x — MIC HEALTH: honest "can I hear?" state for the cockpit
# =============================================================================
# The wake detector already exposes audio_silent via wake.status. This adds the
# device-level context the HUD shows so silent deafness can never look like
# listening: which input device is default, and whether it is being captured
# right now (by us and/or another app such as a call). macOS reads it straight
# from CoreAudio via ctypes (no pyobjc); other platforms report unknown. This
# is a READ — it never opens the device, so it cannot contend with the detector.

def _coreaudio():
    import ctypes
    import sys

    if sys.platform != "darwin":
        return None
    try:
        ca = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
        cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    except OSError:
        return None

    class AudioObjectPropertyAddress(ctypes.Structure):
        _fields_ = [("mSelector", ctypes.c_uint32), ("mScope", ctypes.c_uint32), ("mElement", ctypes.c_uint32)]

    for name, argtypes, restype in (
        ("AudioObjectGetPropertyData", [ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p], ctypes.c_int32),
    ):
        getattr(ca, name).argtypes = argtypes
        getattr(ca, name).restype = restype
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    return {"ca": ca, "cf": cf, "ctypes": ctypes, "Addr": AudioObjectPropertyAddress}


def _fourcc(code: str) -> int:
    return (ord(code[0]) << 24) | (ord(code[1]) << 16) | (ord(code[2]) << 8) | ord(code[3])


def mic_input_status() -> Dict[str, Any]:
    """Default input device + whether it is actively captured right now.

    Returns ``capturing`` True when the device is running somewhere (our own
    detector, a call app, or both) — the HUD uses it as neutral "mic shared"
    context, never as proof of deafness (audio_silent from wake.status is the
    real deafness signal). ``capturing`` is None when it cannot be read.
    """
    import sys

    api = _coreaudio()
    if not api:
        return {"ok": True, "platform": sys.platform, "capturing": None, "device": ""}
    ca, cf, ctypes, Addr = api["ca"], api["cf"], api["ctypes"], api["Addr"]
    OBJ = 1  # kAudioObjectSystemObject
    GLOBAL = _fourcc("glob")
    MAIN = 0

    def get(obj, selector, ctype):
        addr = Addr(_fourcc(selector), GLOBAL, MAIN)
        val = ctype()
        size = ctypes.c_uint32(ctypes.sizeof(ctype))
        rc = ca.AudioObjectGetPropertyData(obj, ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(val))
        return val if rc == 0 else None

    dev = get(OBJ, "dIn ", ctypes.c_uint32)  # kAudioHardwarePropertyDefaultInputDevice
    if dev is None or not dev.value:
        return {"ok": True, "platform": "darwin", "capturing": None, "device": ""}
    running = get(int(dev.value), "gone", ctypes.c_uint32)  # kAudioDevicePropertyDeviceIsRunningSomewhere
    # kAudioObjectPropertyName as a CFString
    name = ""
    addr = Addr(_fourcc("lnam"), GLOBAL, MAIN)
    cfstr = ctypes.c_void_p()
    size = ctypes.c_uint32(ctypes.sizeof(ctypes.c_void_p))
    if ca.AudioObjectGetPropertyData(int(dev.value), ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(cfstr)) == 0 and cfstr.value:
        buf = ctypes.create_string_buffer(256)
        if cf.CFStringGetCString(cfstr.value, buf, 256, 0x08000100):
            name = buf.value.decode("utf-8", "replace")
        cf.CFRelease(cfstr.value)
    return {"ok": True, "platform": "darwin", "capturing": bool(running.value) if running is not None else None, "device": name}


# =============================================================================
# P1-restore — VOICE TRACE: a reliable sink for the interruption/stop diagnosis
# =============================================================================
# Renderer console.warn does not reach the desktop log, so the stop-word / kill
# path is invisible there. This appends renderer-supplied trace lines to
# <home>/logs/voice-trace.log so a live "say stop" test is observable. Pure,
# bounded, no secrets — the renderer sends short step labels only.

def append_voice_trace(home: "Path", line: str) -> Dict[str, Any]:
    import datetime as _dt

    text = str(line or "").strip()[:400]
    if not text:
        return {"ok": True}
    try:
        log_dir = home / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        with (log_dir / "voice-trace.log").open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} [voice] {text}\n")
    except OSError:
        return {"ok": False}
    return {"ok": True}
