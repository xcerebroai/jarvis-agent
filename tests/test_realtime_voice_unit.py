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
    classic = {
        "name": "Blocked Project",
        "status": "Blocked",
        "priority": "Urgent",
        "note": "Needs approval",
        "next_action": "",
        "tasks_done": 1,
        "tasks_total": 2,
        "target_end": "",
    }
    assert len(out["projects"]) == 1
    assert {k: out["projects"][0][k] for k in classic} == classic
    # P5.1 enriched fields ride along on every row (no index_path → no ledger).
    assert out["projects"][0]["revenue_relevance"] == "Unknown"
    assert out["projects"][0]["staleness_days"] is None
    # Free-form detail never leaks into the compact review.
    assert "notes" not in json.dumps(out)
    assert "long detail" not in json.dumps(out)


def test_build_project_review_filters_by_query():
    data = {"projects": [{"name": "Alpha", "status": "A"}, {"name": "Beta", "status": "B"}]}
    out = rv.build_project_review(data, query="beta")
    assert [p["name"] for p in out["projects"]] == ["Beta"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))


# --- P5.1: priority reasoning — enriched schema + voice overrides ------------

_P51_INDEX = {
    "meta": {"updated": "2026-08-20"},
    "projects": [
        {
            "id": "P-1", "name": "Harris Site", "status": "Build Mode", "priority": "normal",
            "targetEnd": "2026-09-03", "tasks": [{"done": True, "label": "a"}, {"done": False, "label": "b"}],
            "payment": {"total": 2500, "paid": 500, "status": "Partial"},
        },
        {
            "id": "P-2", "name": "Coastal Campaign", "status": "Payment Follow-Up", "priority": "high",
            "targetEnd": "", "tasks": [], "payment": {"total": 800, "paid": 800, "status": "Paid"},
        },
        {"id": "P-3", "name": "Harris Ads", "status": "Planning", "tasks": []},
    ],
}


def _write_index(tmp_path):
    index = tmp_path / "projects.json"
    index.write_text(json.dumps(_P51_INDEX), encoding="utf-8")
    return index


def test_enriched_schema_on_read_path(tmp_path):
    index = _write_index(tmp_path)
    review = rv.build_project_review(_P51_INDEX, limit=8, index_path=index, today="2026-08-24")
    by_name = {row["name"]: row for row in review["projects"]}
    harris = by_name["Harris Site"]
    assert harris["priority"] == "Normal"                  # normalized
    assert harris["deadline"] == "2026-09-03"
    assert harris["days_to_deadline"] == 10
    assert harris["staleness_days"] == 0                   # first sighting today
    assert harris["revenue_relevance"] == "High"           # $2000 outstanding
    assert harris["revenue_outstanding"] == 2000.0
    coastal = by_name["Coastal Campaign"]
    assert coastal["revenue_relevance"] == "High"          # payment follow-up status
    assert coastal["priority"] == "High"
    # ledger persisted beside the index, index untouched
    assert (tmp_path / rv.STALENESS_LEDGER_NAME).exists()
    assert json.loads(index.read_text()) == _P51_INDEX
    # sorted: High priority first
    assert review["projects"][0]["name"] == "Coastal Campaign"


def test_staleness_counts_from_last_content_change(tmp_path):
    index = _write_index(tmp_path)
    rows = rv._project_rows(_P51_INDEX)
    rv.update_staleness_ledger(index, rows, now="2026-08-01")
    review = rv.build_project_review(_P51_INDEX, query="harris site", limit=1, index_path=index, today="2026-08-24")
    assert review["projects"][0]["staleness_days"] == 23
    # a content change resets the clock
    changed = json.loads(json.dumps(_P51_INDEX))
    changed["projects"][0]["status"] = "Testing"
    review2 = rv.build_project_review(changed, query="harris site", limit=1, index_path=index, today="2026-08-24")
    assert review2["projects"][0]["staleness_days"] == 0


def test_voice_override_resolves_reference_and_persists(tmp_path):
    index = _write_index(tmp_path)
    rows = rv._project_rows(_P51_INDEX)
    # ambiguous "harris" (two projects) → refused, never guessed
    with pytest.raises(ValueError):
        rv.set_project_override(index, rows, "harris", {"priority": "high"})
    result = rv.set_project_override(index, rows, "harris site", {"priority": "urgent", "deadline": "2026-08-30"})
    assert result["key"] == "P-1" and result["fields"]["priority"] == "Urgent"
    with pytest.raises(ValueError):
        rv.set_project_override(index, rows, "harris site", {"secret": "x"})   # not voice-editable
    review = rv.build_project_review(_P51_INDEX, query="harris site", limit=1, index_path=index, today="2026-08-24")
    row = review["projects"][0]
    assert row["priority"] == "Urgent" and row["deadline"] == "2026-08-30" and row["days_to_deadline"] == 6
    assert row["overridden"] == ["deadline", "priority"]
    assert (tmp_path / rv.LOCAL_OVERRIDES_NAME).exists()
    assert json.loads(index.read_text()) == _P51_INDEX   # the synced index is never written


def test_reasoning_context_is_full_board_compact(tmp_path):
    index = _write_index(tmp_path)
    ctx = rv.build_reasoning_context(_P51_INDEX, index, today="2026-08-24")
    assert ctx["total_projects"] == 3 and ctx["truncated"] == 0
    assert len(ctx["text"].splitlines()) == 3
    assert "Harris Site [Build Mode, Normal priority, deadline 2026-09-03 (+10d)" in ctx["text"]
    assert "revenue High $2000 outstanding" in ctx["text"]


# --- P5.1: sight — honest accounting + permission gate ------------------------


def test_sight_cost_estimate_uses_list_prices_only_for_known_models():
    assert rv.estimate_cost_usd("gpt-4.1-mini", {"prompt_tokens": 1_000_000, "completion_tokens": 0}) == 0.40
    assert rv.estimate_cost_usd("gpt-4.1-mini", {"prompt_tokens": 1200, "completion_tokens": 120}) == pytest.approx(0.000672)
    assert rv.estimate_cost_usd("some-unpriced-model", {"prompt_tokens": 10}) is None
    assert rv.estimate_cost_usd("gpt-4.1-mini", None) is None


def test_sight_config_defaults_and_bounds():
    cfg = rv.resolve_sight_config({})
    assert cfg == {"enabled": True, "model": "gpt-4.1-mini", "max_edge": 1600, "detail": "auto"}
    cfg = rv.resolve_sight_config({"voice": {"realtime": {"sight": {"model": "gpt-4.1", "max_edge": 99999, "enabled": False}}}})
    assert cfg["model"] == "gpt-4.1" and cfg["max_edge"] == 3200 and cfg["enabled"] is False


def test_look_refuses_without_key_and_when_disabled(tmp_path):
    assert rv.look_at_screen(tmp_path, {}, "", "what is on screen")["ok"] is False
    off = rv.look_at_screen(tmp_path, {"voice": {"realtime": {"sight": {"enabled": False}}}}, "sk-x", "")
    assert off["ok"] is False and "disabled" in off["error"]


def test_thumbnail_path_is_confined_to_home(tmp_path):
    outside = tmp_path.parent / "outside.png"
    outside.write_bytes(b"x")
    assert rv.thumbnail_for_path(tmp_path, str(outside))["ok"] is False
    assert rv.thumbnail_for_path(tmp_path, str(tmp_path / "missing.png"))["ok"] is False


# --- P5.1: build sessions — durable registry ---------------------------------


def test_build_registry_roundtrip(tmp_path):
    with pytest.raises(ValueError):
        rv.upsert_build(tmp_path, {"id": "b1", "name": "", "goal": "x"})
    record = rv.upsert_build(tmp_path, {"id": "b1", "name": "Stripe", "goal": "attach stripe", "session_id": "rt-1", "stored_session_id": "st-1"})
    assert record["state"] == "planning" and record["created_at"]
    assert rv.list_builds(tmp_path)[0]["id"] == "b1"
    updated = rv.update_build(tmp_path, "b1", {"state": "waiting", "last_summary": "need keys", "bogus": 1, "session_id": "rt-2"})
    assert updated["state"] == "waiting" and updated["last_summary"] == "need keys" and "bogus" not in updated
    assert updated["session_id"] == "rt-2" and updated["stored_session_id"] == "st-1"
    assert rv.update_build(tmp_path, "b1", {"state": "not-a-state"})["state"] == "waiting"
    assert rv.update_build(tmp_path, "nope", {"state": "done"}) is None
    # upsert keeps created_at, replaces name/goal
    again = rv.upsert_build(tmp_path, {"id": "b1", "name": "Stripe API", "goal": "attach stripe via api"})
    assert again["created_at"] == record["created_at"] and again["name"] == "Stripe API" and again["state"] == "waiting"


def test_board_entry_links_build(tmp_path):
    index = _write_index(tmp_path)
    row = rv.create_local_project(index, "Build: Stripe", goal="attach", source="build-session", build_id="b1", status="Build Mode")
    assert row["build_id"] == "b1" and row["source"] == "build-session" and row["status"] == "Build Mode"
    review = rv.build_project_review({"projects": rv.read_local_additions(index)}, limit=8)
    assert review["projects"][0]["build_id"] == "b1"
