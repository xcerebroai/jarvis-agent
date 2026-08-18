"""Tests for the OpenAI Realtime ephemeral-token mint endpoint.

The desktop's production voice transport is a browser WebRTC speech-to-speech
session against OpenAI Realtime. The browser authenticates its SDP exchange
with a *short-lived* ephemeral secret minted by
``POST /api/audio/realtime/token``. These tests pin the security-critical
contract:

* the standing key is used only as the outbound Bearer and is NEVER returned
  or otherwise leaked to the renderer;
* the key is resolved from the REQUESTED profile's scope;
* missing key / unknown profile / OpenAI auth-rejection / upstream failure all
  map to sanitized, key-free error responses.
"""
import io
import json
import urllib.error

import pytest


@pytest.fixture
def isolated_profiles(tmp_path, monkeypatch, _isolate_hermes_home):
    """Isolated default home + one named profile, each with config + .env."""
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    worker_home = profiles_root / "worker_beta"
    for home in (default_home, worker_home):
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
    (default_home / ".env").write_text("", encoding="utf-8")
    (worker_home / ".env").write_text("", encoding="utf-8")

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_beta": worker_home}


@pytest.fixture
def client(monkeypatch, isolated_profiles):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    # A machine may have a real OPENAI key in its process env — clear both audio
    # keys so "no key configured" cases actually have no key.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("VOICE_TOOLS_OPENAI_KEY", raising=False)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


_STANDING_KEY = "standing-secret-do-not-leak-000"


def _set_key(home, value=_STANDING_KEY):
    (home / ".env").write_text(f"OPENAI_API_KEY={value}\n", encoding="utf-8")


class _FakeResponse:
    def __init__(self, body: bytes):
        self._buf = io.BytesIO(body)

    def read(self):
        return self._buf.read()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_fake_openai(monkeypatch, *, body=None, error=None):
    """Patch the outbound OpenAI mint; capture the request it sent."""
    captured = {}

    def _fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["authorization"] = request.get_header("Authorization")
        captured["body"] = request.data.decode("utf-8") if request.data else ""
        captured["timeout"] = timeout
        if error is not None:
            raise error
        payload = body if body is not None else {
            "value": "ek_ephemeral_abc123",
            "expires_at": 1_900_000_000,
            "session": {"id": "sess_realtime_1"},
        }
        return _FakeResponse(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    return captured


class TestRealtimeTokenMint:
    def test_mints_ephemeral_and_never_returns_standing_key(
        self, client, isolated_profiles, monkeypatch
    ):
        _set_key(isolated_profiles["worker_beta"])
        captured = _install_fake_openai(monkeypatch)

        resp = client.post("/api/audio/realtime/token?profile=worker_beta", json={})

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["value"] == "ek_ephemeral_abc123"
        assert data["model"] == "gpt-realtime-2.1"
        assert data["voice"] == "marin"
        assert data["session_id"] == "sess_realtime_1"

        # The standing key must never appear anywhere in the response.
        assert _STANDING_KEY not in json.dumps(data)

        # ...but it WAS used server-side as the outbound Bearer, and the mint
        # requested the production model.
        assert captured["authorization"] == f"Bearer {_STANDING_KEY}"
        assert captured["url"] == "https://api.openai.com/v1/realtime/client_secrets"
        sent = json.loads(captured["body"])
        assert sent["session"]["model"] == "gpt-realtime-2.1"
        assert sent["session"]["audio"]["output"]["voice"] == "marin"

    def test_key_resolved_from_requested_profile_scope(
        self, client, isolated_profiles, monkeypatch
    ):
        # Key present ONLY in worker_beta — proves per-profile scoping.
        _set_key(isolated_profiles["worker_beta"])
        _install_fake_openai(monkeypatch)

        ok = client.post("/api/audio/realtime/token?profile=worker_beta", json={})
        assert ok.status_code == 200

        # The default profile has no key, so the SAME request there is a 400 —
        # the scope, not the process env, decided the outcome.
        missing = client.post("/api/audio/realtime/token", json={})
        assert missing.status_code == 400
        assert _STANDING_KEY not in json.dumps(missing.json())

    def test_missing_key_returns_400(self, client, isolated_profiles, monkeypatch):
        _install_fake_openai(monkeypatch)
        resp = client.post("/api/audio/realtime/token?profile=worker_beta", json={})
        assert resp.status_code == 400
        assert "openai" in resp.json()["detail"].lower()

    def test_unknown_profile_404(self, client, isolated_profiles):
        resp = client.post("/api/audio/realtime/token?profile=ghost", json={})
        assert resp.status_code == 404

    def test_openai_auth_rejection_maps_to_502_and_hides_key(
        self, client, isolated_profiles, monkeypatch
    ):
        _set_key(isolated_profiles["worker_beta"])
        _install_fake_openai(
            monkeypatch,
            error=urllib.error.HTTPError(
                "https://api.openai.com/v1/realtime/client_secrets",
                401,
                "Unauthorized",
                {},
                io.BytesIO(b'{"error": "invalid key"}'),
            ),
        )
        resp = client.post("/api/audio/realtime/token?profile=worker_beta", json={})
        assert resp.status_code == 502
        assert _STANDING_KEY not in json.dumps(resp.json())

    def test_upstream_failure_maps_to_502(
        self, client, isolated_profiles, monkeypatch
    ):
        _set_key(isolated_profiles["worker_beta"])
        _install_fake_openai(
            monkeypatch,
            error=urllib.error.HTTPError(
                "https://api.openai.com/v1/realtime/client_secrets",
                500,
                "Server Error",
                {},
                io.BytesIO(b"boom"),
            ),
        )
        resp = client.post("/api/audio/realtime/token?profile=worker_beta", json={})
        assert resp.status_code == 502

    def test_no_ephemeral_value_maps_to_502(
        self, client, isolated_profiles, monkeypatch
    ):
        _set_key(isolated_profiles["worker_beta"])
        # OpenAI answered but with no usable ephemeral value.
        _install_fake_openai(monkeypatch, body={"session": {"id": "x"}})
        resp = client.post("/api/audio/realtime/token?profile=worker_beta", json={})
        assert resp.status_code == 502

    def test_accepts_empty_body(self, client, isolated_profiles, monkeypatch):
        _set_key(isolated_profiles["worker_beta"])
        _install_fake_openai(monkeypatch)
        # No JSON body at all (RealtimeTokenRequest is optional).
        resp = client.post("/api/audio/realtime/token?profile=worker_beta")
        assert resp.status_code == 200


def _configure_index(home, rel="projects.json"):
    """Point voice.realtime.review_projects.index_path at a file under *home*."""
    (home / "config.yaml").write_text(
        "voice:\n"
        "  realtime:\n"
        "    assistant_name: ATLAS\n"
        "    user_name: Ada\n"
        "    wake_phrase: atlas online\n"
        "    auto_start: true\n"
        "    voice: cedar\n"
        "    review_projects:\n"
        f"      index_path: {rel}\n",
        encoding="utf-8",
    )
    return home / rel


class TestRealtimeVoiceConfig:
    def test_defaults_are_the_public_product_defaults(self, client, isolated_profiles):
        # Empty config.yaml → JARVIS, no user name, "hey jarvis", marin, review off.
        resp = client.post("/api/audio/realtime/config")
        assert resp.status_code == 200
        data = resp.json()
        assert data["enabled"] is True
        assert data["assistant_name"] == "JARVIS"
        assert data["user_name"] == ""
        assert data["wake_phrase"] == "hey jarvis"
        assert data["auto_start"] is False
        assert data["model"] == "gpt-realtime-2.1"
        assert data["voice"] == "marin"
        assert data["review_projects_enabled"] is False

    def test_config_yaml_overrides_identity_and_enables_review(self, client, isolated_profiles):
        index = _configure_index(isolated_profiles["worker_beta"])
        index.write_text(json.dumps({"projects": []}), encoding="utf-8")

        resp = client.post("/api/audio/realtime/config?profile=worker_beta")
        assert resp.status_code == 200
        data = resp.json()
        assert data["assistant_name"] == "ATLAS"
        assert data["user_name"] == "Ada"
        assert data["wake_phrase"] == "atlas online"
        assert data["auto_start"] is True
        assert data["voice"] == "cedar"
        # Index file exists → review path advertised.
        assert data["review_projects_enabled"] is True

    def test_review_disabled_when_index_missing(self, client, isolated_profiles):
        # Path configured but the file does not exist → still disabled.
        _configure_index(isolated_profiles["worker_beta"], rel="absent.json")
        resp = client.post("/api/audio/realtime/config?profile=worker_beta")
        assert resp.json()["review_projects_enabled"] is False


class TestRealtimeProjectReview:
    def test_404_when_no_index_is_configured(self, client, isolated_profiles):
        resp = client.post("/api/audio/realtime/project-review", json={"limit": 1})
        assert resp.status_code == 404

    def test_returns_compact_ranked_data_without_discarding_source_detail(
        self, client, isolated_profiles
    ):
        index = _configure_index(isolated_profiles["default"])
        source = {
            "updated": "2026-08-17",
            "projects": [
                {
                    "name": "Planning Project",
                    "status": "Planning",
                    "priority": "Normal",
                    "next_action": "Define scope",
                    "notes": "Long valuable detail stays in the index",
                    "tasks": [{"label": "Scope", "done": False}],
                },
                {
                    "name": "Blocked Project",
                    "status": "Blocked",
                    "priority": "Urgent",
                    "blocker": "Needs approval",
                    "next_action": "Approve scope",
                    "tasks": [
                        {"label": "Build", "done": True},
                        {"label": "Approve", "done": False},
                    ],
                },
            ],
        }
        index.write_text(json.dumps(source), encoding="utf-8")

        response = client.post("/api/audio/realtime/project-review", json={"limit": 1})

        assert response.status_code == 200
        data = response.json()
        assert data["source"] == "project index"
        assert data["total_projects"] == 2
        assert data["status_counts"] == {"Planning": 1, "Blocked": 1}
        assert data["detail_retained"] is True
        # Urgent sorts ahead of Normal; limit 1 keeps only the top row.
        assert data["projects"] == [
            {
                "name": "Blocked Project",
                "status": "Blocked",
                "priority": "Urgent",
                "note": "Needs approval",
                "next_action": "Approve scope",
                "tasks_done": 1,
                "tasks_total": 2,
                "target_end": "",
            }
        ]
        # Free-form detail (notes/description) never leaks into the review.
        assert "notes" not in json.dumps(data)
        assert "Long valuable detail" not in json.dumps(data)

    def test_filters_by_project_query(self, client, isolated_profiles):
        index = _configure_index(isolated_profiles["default"])
        source = {
            "updated": "2026-08-17",
            "projects": [
                {"name": "Alpha", "status": "Testing", "tasks": []},
                {"name": "Beta", "status": "Build", "tasks": []},
            ],
        }
        index.write_text(json.dumps(source), encoding="utf-8")

        response = client.post("/api/audio/realtime/project-review", json={"query": "beta"})
        assert response.status_code == 200
        assert [row["name"] for row in response.json()["projects"]] == ["Beta"]
