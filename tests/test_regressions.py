import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import novel_pipeline as np
import web_app
from storage import NovelStore


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    store = NovelStore(tmp_path / "novels.db")
    monkeypatch.setattr(web_app, "NOVEL_STORE", store)
    return store


def _mock_state() -> dict:
    state = np._mock_outline()
    state.update(
        {
            "user_idea": "mock regression test",
            "genre": "urban",
            "current_chapter_idx": 0,
            "current_draft": "",
            "completed_chapters": [],
            "rewrite_count": 0,
        }
    )
    return state


def test_mock_single_chapter_pipeline_terminates():
    with np.use_llm_settings(np.resolve_llm_settings(mock=True)):
        result = np.run_single_chapter(_mock_state())

    assert result["completed_chapters"]
    assert result["current_chapter_idx"] == 1


def test_generate_chapter_endpoint_completes_with_mock(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("NOVEL_MOCK", "1")

    novel = _mock_state()
    novel.update(
        {
            "id": "abcdef12",
            "title": "Mock novel",
            "created_at": "2026-01-01T00:00:00",
            "chapters": [],
        }
    )
    web_app._strip_runtime_fields(novel)
    web_app._save(novel["id"], novel)

    client = TestClient(web_app.app)
    response = client.post("/api/novels/abcdef12/generate-chapter/0")

    assert response.status_code == 200
    assert response.json()["draft"]
    saved = web_app._load("abcdef12")
    assert saved["chapters"][0] == response.json()["draft"]


@pytest.mark.parametrize("novel_id", ["../escape", r"..\escape", "not-a-valid-id", ""])
def test_novel_paths_reject_traversal_and_invalid_ids(tmp_path, monkeypatch, novel_id):
    novels_dir = tmp_path / "novels"
    novels_dir.mkdir()
    monkeypatch.setattr(web_app, "NOVELS_DIR", novels_dir)

    with pytest.raises(HTTPException) as exc_info:
        web_app._novel_path(novel_id)

    assert exc_info.value.status_code == 400
    assert not (tmp_path / "escape.json").exists()


def test_cancel_generation_route_returns_json():
    client = TestClient(web_app.app)

    response = client.post("/api/novels/abcdef12/cancel-generation")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_restore_endpoint_rejects_traversal_id():
    client = TestClient(web_app.app)

    response = client.post(
        "/api/restore-novel",
        json={"id": "../escape", "title": "unsafe"},
    )

    assert response.status_code == 400


def test_request_settings_do_not_erase_server_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "server-side-key")

    settings = web_app._settings_from_headers({})
    request_settings = web_app._settings_from_headers(
        {"x-api-key": "request-side-key", "x-model": "request-model"}
    )

    assert settings.api_key == "server-side-key"
    assert settings.mock is False
    assert request_settings.api_key == "request-side-key"
    assert request_settings.model == "request-model"
    assert os.environ["OPENAI_API_KEY"] == "server-side-key"


def test_review_json_parse_failure_fails_closed(monkeypatch):
    class InvalidReviewLLM:
        def invoke(self, _messages):
            return SimpleNamespace(content="not valid json")

    monkeypatch.setenv("NOVEL_FAST_REVIEW", "0")
    monkeypatch.setattr(np, "_get_llm", lambda: InvalidReviewLLM())

    state = _mock_state()
    state["current_draft"] = "a draft long enough to reach the review parser"
    settings = np.resolve_llm_settings(api_key="test-key", mock=False)
    with np.use_llm_settings(settings):
        result = np.review_chapter(state)

    assert result["review_pass"] is False
    assert result["review_issues"]
    assert result["rewrite_count"] == 1


def test_sqlite_store_survives_new_instance(tmp_path):
    db_path = tmp_path / "persistent.db"
    first = NovelStore(db_path)
    first.save_novel(
        "abcdef12",
        {
            "id": "abcdef12",
            "title": "持久化小说",
            "created_at": "2026-01-01T00:00:00",
            "chapters": ["正文"],
        },
    )

    second = NovelStore(db_path)

    assert second.get_novel("abcdef12")["chapters"] == ["正文"]
    assert second.list_novels()[0]["title"] == "持久化小说"


def test_legacy_json_migration_skips_invalid_ids(tmp_path):
    novels_dir = tmp_path / "legacy"
    novels_dir.mkdir()
    store = NovelStore(tmp_path / "migration.db")
    (novels_dir / "abcdef12.json").write_text(
        '{"id":"wrong-id","title":"旧小说","chapters":[]}',
        encoding="utf-8",
    )
    (novels_dir / "not-valid.json").write_text(
        '{"id":"not-valid","title":"非法小说"}',
        encoding="utf-8",
    )

    imported = store.import_json_dir(novels_dir)

    assert imported == 1
    assert store.get_novel("abcdef12")["id"] == "abcdef12"
    assert len(store.list_novels()) == 1


def test_running_jobs_requeue_and_resume(monkeypatch, isolated_store):
    isolated_store.upsert_job(
        "create-running",
        kind="create",
        status="running",
        payload={"idea": "创意", "title": "小说"},
    )
    isolated_store.upsert_job(
        "gen-abcdef12",
        kind="generate",
        status="queued",
        novel_id="abcdef12",
    )
    started = []
    monkeypatch.setattr(
        web_app,
        "_start_background_job",
        lambda job_id, target, *args: started.append(job_id) or True,
    )

    web_app._resume_durable_jobs()

    assert isolated_store.get_job("create-running")["status"] == "queued"
    assert set(started) == {"create-running", "gen-abcdef12"}


def test_generation_cancellation_is_persistent(isolated_store):
    isolated_store.upsert_job(
        "gen-abcdef12",
        kind="generate",
        status="running",
        novel_id="abcdef12",
        message="正在生成",
    )

    web_app._mark_generation_cancelled("abcdef12", "用户取消")

    reopened = NovelStore(isolated_store.db_path)
    job = reopened.get_job("gen-abcdef12")
    assert job["status"] == "cancelled"
    assert job["result"]["status"] == "cancelled"
    assert job["message"] == "用户取消"


def test_create_request_limits_return_422():
    client = TestClient(web_app.app)

    title_response = client.post(
        "/api/novels",
        json={"title": "x" * 201, "idea": "有效创意"},
    )
    outline_response = client.put(
        "/api/novels/abcdef12",
        json={"outline": [{}] * 5001},
    )

    assert title_response.status_code == 422
    assert outline_response.status_code == 422


def test_import_text_limit_returns_422():
    client = TestClient(web_app.app)

    response = client.post(
        "/api/import-txt",
        json={"text": "x" * 5_000_001, "ai_reconstruct": False},
    )

    assert response.status_code == 422
