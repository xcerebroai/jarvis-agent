"""Pure-stdlib unit tests for the feature's backend logic module.

This imports the overlay's copy of ``hermes_cli/realtime_voice.py`` directly
(no FastAPI / no upstream checkout needed), so CI can validate the configurable
identity resolution and the generic project-index review with just Python. The
full HTTP endpoint contract is exercised by
``tests/hermes_cli/test_web_server_realtime_token.py`` (shipped in the feature
payload) wherever the upstream backend deps are installed.

Run:  python -m pytest tests/test_realtime_voice_unit.py -q
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

# Loading the module by path (below) would otherwise drop a __pycache__ next to
# the payload file; keep the feature payload free of bytecode caches.
sys.dont_write_bytecode = True

_MODULE_PATH = (
    Path(__file__).resolve().parent.parent
    / "features"
    / "realtime-voice"
    / "files"
    / "hermes_cli"
    / "realtime_voice.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("_realtime_voice", _MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rv = _load()


def test_defaults_are_public_product_defaults(tmp_path):
    cfg = rv.resolve_voice_config(tmp_path, {})
    assert cfg["enabled"] is True
    assert cfg["assistant_name"] == "JARVIS"
    assert cfg["user_name"] == ""
    assert cfg["wake_phrase"] == "hey jarvis"
    assert cfg["auto_start"] is False
    assert cfg["model"] == "gpt-realtime-2.1"
    assert cfg["voice"] == "marin"
    assert cfg["review_projects_enabled"] is False
    # No personal/client identity baked in.
    assert "cortana" not in json.dumps(cfg).lower()
    assert "quentin" not in json.dumps(cfg).lower()


def test_config_overrides_and_review_toggle(tmp_path):
    index = tmp_path / "projects.json"
    index.write_text(json.dumps({"projects": []}), encoding="utf-8")
    config = {
        "voice": {
            "realtime": {
                "assistant_name": "ATLAS",
                "user_name": "Ada",
                "wake_phrase": "atlas online",
                "auto_start": True,
                "voice": "cedar",
                "review_projects": {"index_path": "projects.json"},
            }
        }
    }
    cfg = rv.resolve_voice_config(tmp_path, config)
    assert cfg["assistant_name"] == "ATLAS"
    assert cfg["user_name"] == "Ada"
    assert cfg["wake_phrase"] == "atlas online"
    assert cfg["auto_start"] is True
    assert cfg["voice"] == "cedar"
    # Index file exists -> review advertised.
    assert cfg["review_projects_enabled"] is True


def test_review_disabled_when_file_absent(tmp_path):
    config = {"voice": {"realtime": {"review_projects": {"index_path": "nope.json"}}}}
    assert rv.review_enabled(tmp_path, config) is False
    assert rv.resolve_index_path(tmp_path, {}) is None


def test_build_project_review_is_generic_and_ranked():
    data = {
        "updated": "2026-08-17",
        "projects": [
            {
                "name": "Planning Project",
                "status": "Planning",
                "priority": "Normal",
                "next_action": "Define scope",
                "notes": "long detail that must stay in the source",
                "tasks": [{"done": False}],
            },
            {
                "name": "Blocked Project",
                "status": "Blocked",
                "priority": "Urgent",
                "blocker": "Needs approval",
                "tasks": [{"done": True}, {"done": False}],
            },
        ],
    }
    out = rv.build_project_review(data, limit=1)
    assert out["source"] == "project index"
    assert out["total_projects"] == 2
    assert out["status_counts"] == {"Planning": 1, "Blocked": 1}
    assert out["detail_retained"] is True
    # Urgent ranks first; limit 1 keeps only it.
    assert out["projects"] == [
        {
            "name": "Blocked Project",
            "status": "Blocked",
            "priority": "Urgent",
            "note": "Needs approval",
            "next_action": "",
            "tasks_done": 1,
            "tasks_total": 2,
            "target_end": "",
        }
    ]
    # Free-form detail never leaks into the compact review.
    assert "notes" not in json.dumps(out)
    assert "long detail" not in json.dumps(out)


def test_build_project_review_filters_by_query():
    data = {"projects": [{"name": "Alpha", "status": "A"}, {"name": "Beta", "status": "B"}]}
    out = rv.build_project_review(data, query="beta")
    assert [p["name"] for p in out["projects"]] == ["Beta"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
