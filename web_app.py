# -*- coding: utf-8 -*-
"""FastAPI backend — Novel Manager v3 (with settings support)"""
import json, os, uuid, datetime, threading, traceback
import re
import difflib
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import novel_pipeline as np
from storage import NovelStore

HERE = Path(__file__).parent
DATA_DIR = HERE / "data"
NOVELS_DIR = HERE / "novels"
NOVELS_DIR.mkdir(exist_ok=True)
DELETED_NOVELS_DIR = HERE / "deleted_novels"
DELETED_NOVELS_DIR.mkdir(exist_ok=True)
NOVEL_DB_PATH = Path(os.getenv("NOVEL_DB_PATH", str(DATA_DIR / "novels.db")))
NOVEL_STORE = NovelStore(NOVEL_DB_PATH)
NOVEL_ID_RE = re.compile(r"^[0-9a-f]{8}$")
_SAVE_LOCK = threading.Lock()
_ACTIVE_JOBS: set[str] = set()
_ACTIVE_JOBS_LOCK = threading.Lock()

MAX_REQUEST_BYTES = int(os.getenv("NOVEL_MAX_REQUEST_BYTES", "8000000"))
MAX_TITLE_LENGTH = 200
MAX_IDEA_LENGTH = 20_000
MAX_INSTRUCTION_LENGTH = 10_000
MAX_IMPORT_TEXT_LENGTH = 5_000_000
MAX_COLLECTION_ITEMS = 5_000
MAX_CHARACTER_ITEMS = 500


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _initialize_storage()
    yield


app = FastAPI(lifespan=lifespan)


def _cors_origins() -> list[str]:
    configured = os.getenv("NOVEL_CORS_ORIGINS", "").strip()
    if configured:
        return [origin.strip() for origin in configured.split(",") if origin.strip()]
    return ["http://127.0.0.1:8000", "http://localhost:8000"]


_allowed_origins = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials="*" not in _allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_request_body(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            request_size = int(content_length)
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "无效的 Content-Length"})
        if request_size > MAX_REQUEST_BYTES:
            return JSONResponse(status_code=413, content={"detail": "请求体过大"})
    return await call_next(request)


# ── request settings ──

def _settings_from_headers(headers) -> np.LLMSettings:
    """Layer request overrides over server defaults without mutating process env."""
    def optional(*names):
        for name in names:
            value = headers.get(name)
            if value is not None:
                return value
        return None

    return np.resolve_llm_settings(
        api_key=optional("x-api-key", "x-apikey"),
        model=optional("x-model"),
        base_url=optional("x-base-url", "x-baseurl"),
    )


def _initialize_storage():
    NOVELS_DIR.mkdir(exist_ok=True)
    NOVEL_STORE.import_json_dir(NOVELS_DIR)
    _resume_durable_jobs()


def _error_detail(exc):
    text = str(exc).strip() or exc.__class__.__name__
    return text[:1000]


def _validate_novel_id(nid: str) -> str:
    nid = (nid or "").strip()
    if not NOVEL_ID_RE.fullmatch(nid):
        raise HTTPException(400, "无效的小说 ID")
    return nid


def _novel_path(nid: str) -> Path:
    nid = _validate_novel_id(nid)
    root = NOVELS_DIR.resolve()
    path = (root / f"{nid}.json").resolve()
    if path.parent != root:
        raise HTTPException(400, "无效的小说路径")
    return path


def _load(nid):
    nid = _validate_novel_id(nid)
    novel = NOVEL_STORE.get_novel(nid)
    if novel is None:
        raise HTTPException(404, "不存在")
    return _ensure_novel_defaults(novel)


def _save(nid, data):
    nid = _validate_novel_id(nid)
    _validate_novel_payload(data)
    data["id"] = nid
    NOVEL_STORE.save_novel(nid, data)


def _validate_novel_payload(data: dict) -> None:
    if not isinstance(data, dict):
        raise HTTPException(422, "小说数据必须是对象")
    for key, limit in (("title", MAX_TITLE_LENGTH), ("idea", MAX_IDEA_LENGTH)):
        value = data.get(key, "")
        if value is not None and not isinstance(value, str):
            raise HTTPException(422, f"{key} 必须是文本")
        if len(value or "") > limit:
            raise HTTPException(422, f"{key} 超过长度限制")
    if data.get("world_setting") is not None and not isinstance(data["world_setting"], dict):
        raise HTTPException(422, "world_setting 必须是对象")
    if data.get("volume_outline") is not None and not isinstance(data["volume_outline"], dict):
        raise HTTPException(422, "volume_outline 必须是对象")
    if data.get("story_bible") is not None and not isinstance(data["story_bible"], dict):
        raise HTTPException(422, "story_bible 必须是对象")
    for key, limit in (
        ("characters", MAX_CHARACTER_ITEMS),
        ("volume_outlines", MAX_COLLECTION_ITEMS),
        ("pacing_outline", MAX_COLLECTION_ITEMS),
        ("outline", MAX_COLLECTION_ITEMS),
        ("chapters", MAX_COLLECTION_ITEMS),
    ):
        value = data.get(key, [])
        if value is None:
            data[key] = []
            continue
        if not isinstance(value, list):
            raise HTTPException(422, f"{key} 必须是列表")
        if len(value) > limit:
            raise HTTPException(422, f"{key} 数量超过限制")
    if any(not isinstance(chapter, str) for chapter in data.get("chapters", [])):
        raise HTTPException(422, "chapters 只能包含文本章节")


def _deleted_path(name: str) -> Path:
    if not name or "/" in name or "\\" in name or not name.endswith(".json"):
        raise HTTPException(400, "无效的回收站文件")
    p = (DELETED_NOVELS_DIR / name).resolve()
    if DELETED_NOVELS_DIR.resolve() not in p.parents:
        raise HTTPException(400, "无效的回收站文件")
    if not p.exists():
        raise HTTPException(404, "回收站中不存在")
    return p


def _write_json_atomic(path: Path, data: dict) -> None:
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with _SAVE_LOCK:
        try:
            temp_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)


def _ensure_novel_defaults(novel):
    if not isinstance(novel.get("volume_outlines"), list):
        vol = novel.get("volume_outline", {})
        novel["volume_outlines"] = [vol] if isinstance(vol, dict) and vol else []
    if novel.get("volume_outlines"):
        novel["volume_outline"] = novel["volume_outlines"][0]
    else:
        novel.setdefault("volume_outline", {})
    novel.setdefault("pacing_outline", [])
    novel.setdefault("story_bible", {
        "timeline": [],
        "character_states": [],
        "open_threads": [],
        "resolved_threads": [],
        "locations": [],
        "chapter_events": [],
        "blacklist": [],
        "continuity_notes": "",
        "last_chapter_summary": "",
    })
    if isinstance(novel.get("story_bible"), dict):
        novel["story_bible"].setdefault("chapter_events", [])
        novel["story_bible"].setdefault("blacklist", [])
    novel.setdefault("chapters", [])
    return novel


class CreateReq(BaseModel):
    title: str = Field(default="", max_length=MAX_TITLE_LENGTH)
    idea: str = Field(default="", max_length=MAX_IDEA_LENGTH)
    genre: str = Field(default="", max_length=200)
    source_title: str = Field(default="", max_length=MAX_TITLE_LENGTH)
    source_summary: str = Field(default="", max_length=MAX_IDEA_LENGTH)

class SaveReq(BaseModel):
    id: str = Field(default="", max_length=32)
    title: str = Field(default="", max_length=MAX_TITLE_LENGTH)
    idea: str = Field(default="", max_length=MAX_IDEA_LENGTH)
    world_setting: dict = Field(default_factory=dict)
    characters: list = Field(default_factory=list, max_length=MAX_CHARACTER_ITEMS)
    volume_outline: dict = Field(default_factory=dict)
    volume_outlines: list = Field(default_factory=list, max_length=MAX_COLLECTION_ITEMS)
    pacing_outline: list = Field(default_factory=list, max_length=MAX_COLLECTION_ITEMS)
    story_bible: dict = Field(default_factory=dict)
    outline: list = Field(default_factory=list, max_length=MAX_COLLECTION_ITEMS)
    chapters: list = Field(default_factory=list, max_length=MAX_COLLECTION_ITEMS)
    created_at: str = Field(default="", max_length=100)

class ExpandReq(BaseModel):
    count: int = Field(default=5, ge=1, le=20)

class RewriteReq(BaseModel):
    instructions: str = Field(default="", max_length=MAX_INSTRUCTION_LENGTH)

class AssistUpdateReq(BaseModel):
    target: str = Field(default="all", max_length=50)
    instructions: str = Field(default="", max_length=MAX_INSTRUCTION_LENGTH)

class AuditReq(BaseModel):
    focus: str = Field(default="all", max_length=2_000)

class RestoreNovelReq(SaveReq):
    pass

class ImportTxtReq(BaseModel):
    title: str = Field(default="", max_length=MAX_TITLE_LENGTH)
    text: str = Field(default="", max_length=MAX_IMPORT_TEXT_LENGTH)
    genre: str = Field(default="", max_length=200)
    ai_reconstruct: bool = True


CHAPTER_TITLE_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:[【\[\(（]\s*)?"
    r"(第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷集部篇]\s*[^\n\r#]{0,100})"
    r"(?:\s*[】\]\)）])?\s*$"
)


def _strip_runtime_fields(novel):
    for k in ("completed_chapters", "current_chapter_idx", "rewrite_count", "current_draft", "archived_draft",
              "review_scores", "review_feedback", "review_pass", "review_issues", "review_suggestions",
              "continuity_pass", "continuity_issues", "continuity_suggestions"):
        novel.pop(k, None)
    return novel


def _clean_import_text(text: str) -> str:
    text = (text or "").replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _clean_chapter_title(line: str) -> str:
    title = (line or "").strip()
    title = re.sub(r"^\s*#{1,6}\s*", "", title)
    pairs = {"【": "】", "[": "]", "(": ")", "（": "）"}
    if title and title[0] in pairs and title.endswith(pairs[title[0]]):
        title = title[1:-1]
    return title.strip()


def _split_txt_chapters(text: str) -> list:
    text = _clean_import_text(text)
    if not text:
        return []

    lines = text.split("\n")
    starts = []
    for i, line in enumerate(lines):
        if CHAPTER_TITLE_RE.match(line.strip()):
            starts.append(i)

    chapters = []
    if starts:
        for pos, start in enumerate(starts):
            end = starts[pos + 1] if pos + 1 < len(starts) else len(lines)
            title = _clean_chapter_title(lines[start])
            body_lines = lines[start + 1:end]
            body = "\n".join(body_lines).strip()
            if body:
                chapters.append({"title": title, "body": body})
        prefix = "\n".join(lines[:starts[0]]).strip()
        if prefix and chapters:
            chapters[0]["body"] = prefix + "\n\n" + chapters[0]["body"]
        return chapters

    parts = [p.strip() for p in re.split(r"\n\s*(?:-{3,}|={3,}|_{3,})\s*\n", text) if p.strip()]
    if len(parts) > 1:
        return [{"title": f"第{i + 1}章", "body": p} for i, p in enumerate(parts)]

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    buckets, current, current_len = [], [], 0
    target_len = 3500
    for para in paragraphs:
        if current and current_len + len(para) > target_len:
            buckets.append("\n\n".join(current))
            current, current_len = [], 0
        current.append(para)
        current_len += len(para)
    if current:
        buckets.append("\n\n".join(current))
    return [{"title": f"第{i + 1}章", "body": p} for i, p in enumerate(buckets)]


def _summary_from_body(body: str, limit: int = 120) -> str:
    compact = re.sub(r"\s+", " ", (body or "")).strip()
    return compact[:limit]


def _build_imported_novel(title: str, text: str, genre: str = "") -> dict:
    chapters_raw = _split_txt_chapters(text)
    if not chapters_raw:
        raise HTTPException(400, "TXT 内容为空，或没有可导入的正文")

    title = (title or "").strip() or "导入的小说"
    chapters = [c["body"] for c in chapters_raw]
    outline = []
    for i, ch in enumerate(chapters_raw):
        outline.append({
            "chapter_number": i + 1,
            "title": ch["title"] or f"第{i + 1}章",
            "summary": _summary_from_body(ch["body"]),
            "conflict": "由导入正文自动生成，可在大纲页继续编辑",
            "hook": "由导入正文自动生成，可在大纲页继续编辑",
            "key_scenes": [],
            "characters_involved": [],
        })

    chapter_end = max(len(chapters), 1)
    volume_outline = {
        "name": "导入篇章",
        "arc": "根据 TXT 正文导入生成。建议使用 AI 辅助更新补全篇章目标、世界观与角色卡。",
        "chapter_start": 1,
        "chapter_end": chapter_end,
        "core_conflict": "待补全",
        "climax": "待补全",
        "key_events": [o["summary"] for o in outline[:5] if o.get("summary")],
    }
    step = max((chapter_end + 4) // 5, 1)
    pacing_outline = []
    start = 1
    while start <= chapter_end:
        end = min(chapter_end, start + step - 1)
        pacing_outline.append({
            "name": f"导入段落 {len(pacing_outline) + 1}",
            "chapter_start": start,
            "chapter_end": end,
            "purpose": "根据导入章节占位生成，可继续编辑",
            "major_turning_point": "待补全",
            "tension_goal": "待补全",
        })
        start = end + 1

    return {
        "id": uuid.uuid4().hex[:8],
        "title": title,
        "created_at": datetime.datetime.now().isoformat(),
        "idea": f"从 TXT 导入：{title}",
        "genre": genre or "",
        "world_setting": {
            "premise": "从 TXT 正文导入，世界观待补全。",
            "core_hook": "待补全",
            "rules": "待补全",
            "locations": [],
            "factions": [],
            "power_system": "待补全",
            "tone": "待补全",
        },
        "characters": [],
        "volume_outline": volume_outline,
        "volume_outlines": [volume_outline],
        "pacing_outline": pacing_outline,
        "story_bible": {
            "timeline": [f"已导入 {len(chapters)} 章正文。"],
            "character_states": [],
            "open_threads": [],
            "resolved_threads": [],
            "locations": [],
            "continuity_notes": "本小说由 TXT 导入，建议使用 AI 辅助更新补全剧情圣经。",
            "last_chapter_summary": _summary_from_body(chapters[-1]) if chapters else "",
        },
        "outline": outline,
        "chapters": chapters,
    }


def _reconstruct_imported_metadata(
    novel: dict, chapters_raw: list, settings: np.LLMSettings
) -> tuple[dict, str]:
    try:
        with np.use_llm_settings(settings):
            rebuilt = np.reconstruct_imported_novel(novel, chapters_raw)
        for key in ("world_setting", "characters", "volume_outline", "volume_outlines", "pacing_outline", "story_bible", "outline"):
            if key in rebuilt and rebuilt[key]:
                novel[key] = rebuilt[key]
        if novel.get("volume_outlines"):
            novel["volume_outline"] = novel["volume_outlines"][0]
        elif novel.get("volume_outline"):
            novel["volume_outlines"] = [novel["volume_outline"]]
        return novel, ""
    except Exception as exc:
        novel.setdefault("story_bible", {})
        old = (novel["story_bible"].get("continuity_notes") or "").strip()
        note = f"AI 反向建档失败，已保留基础导入结构：{exc}"
        novel["story_bible"]["continuity_notes"] = f"{old}\n{note}".strip()
        return novel, str(exc)


def _chapter_state(novel, idx):
    chapters = list(novel.get("chapters", []))
    return {
        "user_idea": novel.get("idea", ""),
        "genre": novel.get("genre", ""),
        "world_setting": novel.get("world_setting", {}),
        "characters": novel.get("characters", []),
        "volume_outline": novel.get("volume_outline", {}),
        "pacing_outline": novel.get("pacing_outline", []),
        "story_bible": novel.get("story_bible", {}),
        "audit_report": novel.get("audit_report", {}),
        "outline": novel.get("outline", []),
        "current_chapter_idx": idx,
        "current_draft": "",
        "completed_chapters": chapters[:idx],
        "review_scores": {"logic_consistency": 0, "pacing": 0, "language_quality": 0, "hook_strength": 0, "character_consistency": 0, "total": 0},
        "review_feedback": "",
        "review_pass": True,
        "review_issues": [],
        "review_suggestions": [],
        "continuity_pass": True,
        "continuity_issues": [],
        "continuity_suggestions": [],
        "rewrite_count": 0,
    }


def _save_chapter_result(nid, novel, idx, result):
    completed = result.get("completed_chapters", []) or []
    draft = result.get("archived_draft") or result.get("current_draft", "") or (completed[-1] if completed else "")
    chapters = list(novel.get("chapters", []))
    while len(chapters) <= idx:
        chapters.append("")
    chapters[idx] = draft
    novel["chapters"] = chapters
    if result.get("story_bible"):
        novel["story_bible"] = result["story_bible"]
    _save(nid, novel)
    return draft


def _repair_chapter_alignment(novel: dict, idx: int, draft: str, np, extra_reason: str = "") -> tuple[str, dict, list[str]]:
    """保存前兜底：正文必须贴合当前章节大纲。返回修订稿、状态、问题列表。"""
    state = _chapter_state(novel, idx)
    state["current_draft"] = draft or ""
    issues, suggestions = np._outline_alignment_issues(state)
    if extra_reason:
        issues = list(dict.fromkeys([extra_reason] + (issues or [])))
    if not issues:
        return draft or "", state, []

    state["review_issues"] = issues
    state["review_suggestions"] = (suggestions or []) + [
        "以当前章节大纲为唯一目标重写正文，必须落实梗概、冲突、关键场景和结尾钩子。",
    ]
    max_rounds = max(1, min(int(os.getenv("NOVEL_REPAIR_MAX_ROUNDS", "2") or 2), 3))
    for _ in range(max_rounds):
        state.update(np.revise_chapter(state))
        state.update(np.review_chapter(state))
        state.update(np.continuity_check(state))
        next_issues, next_suggestions = np._outline_alignment_issues(state)
        if not next_issues and state.get("continuity_pass", True):
            break
        state["review_issues"] = list(dict.fromkeys((state.get("review_issues", []) or []) + next_issues))
        state["review_suggestions"] = list(dict.fromkeys((state.get("review_suggestions", []) or []) + next_suggestions))

    state.update(np.update_story_bible(state))
    return state.get("current_draft", draft or ""), state, issues


def _audit_rewrite_indexes(novel: dict) -> list[int]:
    report = novel.get("audit_report") or {}
    outline = novel.get("outline", []) or []
    chapters = novel.get("chapters", []) or []
    idxs = []
    for issue in report.get("issues", []) or []:
        for num in issue.get("chapter_numbers", []) or []:
            try:
                idx = int(num) - 1
            except Exception:
                continue
            if 0 <= idx < len(outline) and idx < len(chapters):
                idxs.append(idx)
    return sorted(set(idxs))


def _merge_character_cards(existing: list, incoming: list) -> list:
    existing_cards = [dict(c) for c in (existing or []) if isinstance(c, dict)]
    incoming_cards = [dict(c) for c in (incoming or []) if isinstance(c, dict)]
    if not existing_cards:
        return incoming_cards
    if len(incoming_cards) == len(existing_cards):
        return incoming_cards

    merged = existing_cards[:]
    name_to_idx = {}
    for i, card in enumerate(existing_cards):
        name = (card.get("name") or "").strip()
        if name and name not in name_to_idx:
            name_to_idx[name] = i

    for card in incoming_cards:
        name = (card.get("name") or "").strip()
        if name and name in name_to_idx:
            idx = name_to_idx[name]
            merged[idx] = {**merged[idx], **card}
        else:
            merged.append(card)
    return merged


def _generate_chapter_payload(nid: str, novel: dict, idx: int):
    result = np.run_single_chapter(_chapter_state(novel, idx))
    completed = result.get("completed_chapters", []) or []
    draft = result.get("archived_draft") or result.get("current_draft", "") or (completed[-1] if completed else "")
    draft, repaired_state, alignment_issues = _repair_chapter_alignment(novel, idx, draft, np)
    if alignment_issues:
        result.update(repaired_state)
        result["archived_draft"] = draft
        result["current_draft"] = draft
    draft = _save_chapter_result(nid, novel, idx, result)
    outline = list(novel.get("outline", []) or [])
    chapter = outline[idx] if idx < len(outline) and isinstance(outline[idx], dict) else {}
    chapter_no = int(chapter.get("chapter_number", idx + 1) or (idx + 1))
    return {
        "chapter_index": idx,
        "chapter_number": chapter_no,
        "chapter_title": chapter.get("title", ""),
        "draft": draft,
        "review": {
            "scores": result.get("review_scores", {}),
            "pass": result.get("review_pass", True),
            "feedback": result.get("review_feedback", ""),
            "rewrite_count": result.get("rewrite_count", 0),
        },
        "continuity": {
            "pass": result.get("continuity_pass", True),
            "issues": result.get("continuity_issues", []),
        },
        "outline_alignment_repaired": bool(alignment_issues),
        "outline_alignment_issues": alignment_issues,
        "story_bible": result.get("story_bible", {}),
    }


def _chapter_repetition_reason(novel: dict, idx: int, draft: str) -> str:
    body = re.sub(r"\s+", "", draft or "")
    if not body:
        return ""
    chapters = list(novel.get("chapters", []) or [])
    outline = list(novel.get("outline", []) or [])
    current = outline[idx] if idx < len(outline) and isinstance(outline[idx], dict) else {}
    sig = body[:700]
    for prev_idx in range(max(0, idx - 5), idx):
        prev = chapters[prev_idx] if prev_idx < len(chapters) else ""
        prev_body = re.sub(r"\s+", "", prev or "")
        if not prev_body:
            continue
        ratio = difflib.SequenceMatcher(None, sig, prev_body[:700]).ratio()
        if ratio >= 0.48:
            return f"与第{prev_idx + 1}章重复度过高，可能重复描写同一事件或桥段"
    title = (current.get("title") or "").strip()
    summary = (current.get("summary") or "").strip()
    if title and title in body[:120]:
        return "章节开头过于接近标题，可能只是复述大纲"
    if summary:
        keywords = [w for w in re.split(r"[，。；、\s]+", summary) if len(w) >= 2][:4]
        if keywords:
            hits = sum(1 for w in keywords if w in body)
            if hits <= max(1, len(keywords) // 2 - 1):
                return "正文与当前章节大纲关联偏弱，可能跑偏或重复前文"
    return ""


def _start_background_job(job_id: str, target, *args) -> bool:
    with _ACTIVE_JOBS_LOCK:
        if job_id in _ACTIVE_JOBS:
            return False
        _ACTIVE_JOBS.add(job_id)

    def run():
        try:
            target(*args)
        except Exception as exc:
            traceback.print_exc()
            NOVEL_STORE.update_job(
                job_id,
                status="error",
                error=_error_detail(exc),
                message="后台任务异常终止",
            )
        finally:
            with _ACTIVE_JOBS_LOCK:
                _ACTIVE_JOBS.discard(job_id)

    try:
        threading.Thread(target=run, daemon=True).start()
    except Exception as exc:
        with _ACTIVE_JOBS_LOCK:
            _ACTIVE_JOBS.discard(job_id)
        NOVEL_STORE.update_job(
            job_id,
            status="error",
            error=_error_detail(exc),
            message="后台任务启动失败",
        )
        return False
    return True


def _resume_durable_jobs():
    NOVEL_STORE.requeue_running_jobs()
    settings = np.resolve_llm_settings()
    for job in NOVEL_STORE.list_jobs(("queued", "running")):
        job_id = job["id"]
        if job["kind"] == "create":
            _start_background_job(job_id, _create_novel_worker, job_id, settings)
        elif job["kind"] == "generate" and job.get("novel_id"):
            _start_background_job(
                job_id, _generate_remaining_worker, job_id, job["novel_id"], settings
            )
        else:
            NOVEL_STORE.update_job(
                job_id,
                status="error",
                error="无法恢复未知或缺少小说 ID 的后台任务",
                message="任务恢复失败",
            )


def _create_novel_worker(job_id: str, settings: np.LLMSettings):
    job = NOVEL_STORE.get_job(job_id)
    if not job:
        return
    payload = job.get("payload") or {}
    try:
        NOVEL_STORE.update_job(
            job_id,
            status="running",
            message="正在生成世界观、角色卡和大纲...",
        )
        with np.use_llm_settings(settings):
            out = np.generate_outline(
                {
                    "user_idea": payload.get("idea", ""),
                    "genre": payload.get("genre", ""),
                    "source_title": payload.get("source_title", ""),
                    "source_summary": payload.get("source_summary", ""),
                }
            )
        novel = {
            "id": uuid.uuid4().hex[:8],
            "title": (payload.get("title") or "").strip() or "未命名小说",
            "created_at": datetime.datetime.now().isoformat(),
            "idea": payload.get("idea", ""),
            "genre": payload.get("genre", ""),
            **out,
            "chapters": [],
        }
        _strip_runtime_fields(novel)
        _save(novel["id"], novel)
        NOVEL_STORE.update_job(
            job_id,
            status="done",
            novel_id=novel["id"],
            result={"title": novel["title"]},
            message="生成完成",
        )
    except Exception as e:
        traceback.print_exc()
        NOVEL_STORE.update_job(
            job_id,
            status="error",
            error=_error_detail(e),
            message="生成失败",
        )


@app.get("/api/novels")
def list_novels():
    items = []
    for d in NOVEL_STORE.list_novels():
        items.append({
            "id": d.get("id", ""), "title": d.get("title", "未命名小说"),
            "created_at": d.get("created_at", ""),
            "idea_preview": d.get("idea", "")[:80],
            "chapter_count": len(d.get("chapters", [])),
        })
    return items


@app.get("/api/deleted-novels")
def list_deleted_novels():
    items = []
    for f in sorted(DELETED_NOVELS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        items.append({
            "file": f.name,
            "id": d.get("id", ""),
            "title": d.get("title", "未命名小说"),
            "created_at": d.get("created_at", ""),
            "deleted_at": datetime.datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            "idea_preview": d.get("idea", "")[:80],
            "chapter_count": len(d.get("chapters", [])),
        })
    return items


@app.post("/api/novels", status_code=201)
async def create_novel(body: CreateReq, request: Request):
    if not body.idea.strip():
        raise HTTPException(400, "创意不能为空")
    settings = _settings_from_headers(request.headers)
    job_id = uuid.uuid4().hex[:10]
    NOVEL_STORE.upsert_job(
        job_id,
        kind="create",
        status="queued",
        payload={
            "title": body.title,
            "idea": body.idea,
            "genre": body.genre,
            "source_title": body.source_title,
            "source_summary": body.source_summary,
        },
        message="任务已创建",
    )
    _start_background_job(job_id, _create_novel_worker, job_id, settings)
    return {"job_id": job_id, "status": "queued"}


@app.post("/api/import-txt", status_code=201)
def import_txt(body: ImportTxtReq, request: Request):
    novel = _build_imported_novel(body.title, body.text, body.genre)
    chapters_raw = _split_txt_chapters(body.text)
    reconstruct_error = ""
    if body.ai_reconstruct:
        novel, reconstruct_error = _reconstruct_imported_metadata(
            novel, chapters_raw, _settings_from_headers(request.headers)
        )
    _strip_runtime_fields(novel)
    _save(novel["id"], novel)
    return {
        "ok": True,
        "id": novel["id"],
        "title": novel["title"],
        "chapter_count": len(novel["chapters"]),
        "reconstructed": not bool(reconstruct_error),
        "reconstruct_error": reconstruct_error,
    }


@app.post("/api/novels/{nid}/resplit-imported")
def resplit_imported_novel(nid: str, request: Request):
    novel = _load(nid)
    text_parts = []
    for i, body in enumerate(novel.get("chapters", []) or []):
        title = ""
        if i < len(novel.get("outline", []) or []):
            title = (novel.get("outline", [])[i] or {}).get("title", "")
        raw = body or ""
        first_line = raw.splitlines()[0].strip() if raw.splitlines() else ""
        if first_line and CHAPTER_TITLE_RE.match(first_line):
            text_parts.append(raw)
        else:
            text_parts.append(f"# 第{i + 1}章 {title or f'第{i + 1}章'}\n\n{raw}")
    merged_text = "\n\n".join(text_parts)
    rebuilt = _build_imported_novel(novel.get("title", ""), merged_text, novel.get("genre", ""))
    rebuilt["id"] = novel["id"]
    rebuilt["title"] = novel.get("title", rebuilt["title"])
    rebuilt["created_at"] = novel.get("created_at", rebuilt["created_at"])
    if request.headers.get("x-resplit-ai", "0") == "1":
        rebuilt, _ = _reconstruct_imported_metadata(
            rebuilt,
            _split_txt_chapters(merged_text),
            _settings_from_headers(request.headers),
        )
    _strip_runtime_fields(rebuilt)
    _save(nid, rebuilt)
    return {"ok": True, "chapter_count": len(rebuilt["chapters"]), "outline_count": len(rebuilt["outline"])}


@app.get("/api/create-jobs/{job_id}")
def create_job_status(job_id: str):
    job = NOVEL_STORE.get_job(job_id)
    if not job or job["kind"] != "create":
        return {
            "status": "missing",
            "message": "任务不存在",
            "novel_id": None,
            "error": "",
        }
    result = job.get("result") or {}
    return {
        "status": job["status"],
        "message": job.get("message", ""),
        "novel_id": job.get("novel_id"),
        "title": result.get("title", ""),
        "error": job.get("error") or "",
    }


@app.get("/api/novels/{nid}")
def get_novel(nid: str):
    return _load(nid)


@app.put("/api/novels/{nid}")
def update_novel(nid: str, body: SaveReq):
    novel = _load(nid)
    provided = getattr(body, "model_fields_set", getattr(body, "__fields_set__", set()))
    for k in ("title", "idea", "world_setting", "characters", "volume_outline", "volume_outlines", "pacing_outline", "story_bible", "outline", "chapters"):
        if k not in provided:
            continue
        v = getattr(body, k, None)
        if v is not None:
            novel[k] = v
    if "volume_outlines" in provided:
        if novel.get("volume_outlines"):
            novel["volume_outline"] = novel["volume_outlines"][0]
        else:
            novel["volume_outline"] = {}
    elif "volume_outline" in provided and novel.get("volume_outline"):
        novel["volume_outlines"] = [novel["volume_outline"]]
    if "outline" in provided or "pacing_outline" in provided or "volume_outline" in provided or "volume_outlines" in provided:
        _state = {
            "volume_outline": novel.get("volume_outline", {}),
            "pacing_outline": novel.get("pacing_outline", []),
            "outline": novel.get("outline", []),
        }
        # ????????????????????
        if "volume_outline" in provided or "volume_outlines" in provided:
            _state["force"] = True
        novel["pacing_outline"] = np.sync_pacing_outline_for_outline(_state)
    _save(nid, novel)
    return {"ok": True}


@app.post("/api/novels/{nid}/assist-update")
def assist_update(nid: str, body: AssistUpdateReq, request: Request):
    """AI 按用户方向辅助更新世界观、角色卡、大纲或剧情圣经。"""
    if not body.instructions.strip():
        raise HTTPException(400, "修改方向不能为空")
    novel = _load(nid)
    settings = _settings_from_headers(request.headers)
    try:
        with np.use_llm_settings(settings):
            updated = np.assist_update_novel(novel, body.target, body.instructions)
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(500, f"AI 辅助更新失败：{_error_detail(exc)}")
    if not updated:
        raise HTTPException(500, "AI 没有返回可更新内容")

    for key in ("world_setting", "characters", "volume_outline", "volume_outlines", "pacing_outline", "outline", "story_bible"):
        if key in updated:
            if key == "characters":
                novel[key] = _merge_character_cards(novel.get("characters", []), updated[key])
            else:
                novel[key] = updated[key]
    if updated.get("append_characters"):
        novel["characters"] = list(novel.get("characters", [])) + list(updated["append_characters"])
    if updated.get("append_pacing_outline"):
        novel["pacing_outline"] = list(novel.get("pacing_outline", [])) + list(updated["append_pacing_outline"])
    if updated.get("append_volume_outlines"):
        current = list(novel.get("volume_outlines", []) or ([novel.get("volume_outline")] if novel.get("volume_outline") else []))
        for vol in updated["append_volume_outlines"]:
            if isinstance(vol, dict):
                item = dict(vol)
                item.setdefault("name", f"新篇章 {len(current) + 1}")
                item.setdefault("arc", "")
                item.setdefault("chapter_start", 1)
                item.setdefault("chapter_end", item.get("chapter_start", 1))
                item.setdefault("core_conflict", "")
                item.setdefault("climax", "")
                item.setdefault("key_events", [])
                current.append(item)
        novel["volume_outlines"] = current
    if updated.get("append_outline"):
        outline = list(novel.get("outline", []))
        next_num = (outline[-1].get("chapter_number", len(outline)) + 1) if outline else 1
        for i, ch in enumerate(updated["append_outline"]):
            if isinstance(ch, dict):
                item = dict(ch)
                item["chapter_number"] = next_num + i
                item.setdefault("title", f"第{next_num + i}章")
                item.setdefault("summary", "")
                item.setdefault("conflict", "")
                item.setdefault("hook", "")
                item.setdefault("key_scenes", [])
                item.setdefault("characters_involved", [])
                outline.append(item)
        novel["outline"] = outline
        novel["pacing_outline"] = np.sync_pacing_outline_for_outline({
            "volume_outline": novel.get("volume_outline", {}),
            "pacing_outline": novel.get("pacing_outline", []),
            "outline": outline,
        })
    if novel.get("volume_outlines"):
        novel["volume_outline"] = novel["volume_outlines"][0]
    elif "volume_outlines" in updated:
        novel["volume_outline"] = {}
    elif novel.get("volume_outline"):
        novel["volume_outlines"] = [novel["volume_outline"]]
    _save(nid, novel)
    shown = [k for k in updated.keys() if not k.startswith("append_")]
    if updated.get("append_characters"):
        shown.append("新增角色卡")
    if updated.get("append_pacing_outline"):
        shown.append("新增节奏段")
    if updated.get("append_volume_outlines"):
        shown.append("新增篇章大纲")
    if updated.get("append_outline"):
        shown.append("新增章节大纲")
    return {"ok": True, "updated": shown, "novel": novel}


@app.post("/api/novels/{nid}/audit")
def audit_novel_endpoint(nid: str, body: AuditReq, request: Request):
    """AI 审稿：检查章节与设定、大纲、剧情圣经之间的冲突、重复和跑偏。"""
    novel = _load(nid)
    if not any((ch or "").strip() for ch in novel.get("chapters", []) or []):
        raise HTTPException(400, "还没有已生成章节，无法审稿")
    settings = _settings_from_headers(request.headers)
    try:
        with np.use_llm_settings(settings):
            report = np.audit_novel(novel, body.focus)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(500, f"小说审稿失败：{_error_detail(exc)}")
    novel["audit_report"] = {
        **report,
        "focus": body.focus,
        "created_at": datetime.datetime.now().isoformat(),
    }
    bible = dict(novel.get("story_bible", {}) or {})
    blacklist = list(bible.get("blacklist", []) or [])
    for issue in report.get("issues", []) or []:
        if not isinstance(issue, dict):
            continue
        if issue.get("type") not in ("重复章节", "重复桥段", "大纲偏离", "节奏错位"):
            continue
        blacklist.append({
            "source": "audit",
            "level": "pattern",
            "chapter_number": ",".join(str(n) for n in (issue.get("chapter_numbers", []) or [])),
            "title": issue.get("title", ""),
            "summary": issue.get("evidence", "") or issue.get("suggestion", ""),
            "conflict": issue.get("type", ""),
            "hook": issue.get("suggestion", ""),
            "characters_involved": [],
            "key_scenes": [],
            "tags": [f"来源:audit", f"问题:{issue.get('type', '')[:16]}"],
        })
    bible["blacklist"] = blacklist[-200:]
    novel["story_bible"] = bible
    _save(nid, novel)
    return {"ok": True, "report": novel["audit_report"]}


@app.post("/api/novels/{nid}/audit/apply-outline")
def apply_audit_to_outline(nid: str, request: Request):
    """根据最近一次审稿报告更新篇章/节奏/章节大纲与剧情圣经备注，并同步重写受影响章节。"""
    novel = _load(nid)
    if not novel.get("audit_report"):
        raise HTTPException(400, "还没有审稿报告，请先审稿")
    settings = _settings_from_headers(request.headers)
    try:
        with np.use_llm_settings(settings):
            updated = np.update_outline_from_audit(novel)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(500, f"根据审稿更新大纲失败：{_error_detail(exc)}")
    if not updated:
        updated = np.update_outline_from_audit({**novel, "__force_mock": True})
    if not updated:
        raise HTTPException(500, "没有可应用的审稿问题，请先重新审稿")
    for key in ("volume_outline", "volume_outlines", "pacing_outline", "outline", "story_bible"):
        if key in updated:
            novel[key] = updated[key]
    if novel.get("volume_outlines"):
        novel["volume_outline"] = novel["volume_outlines"][0]
    elif novel.get("volume_outline"):
        novel["volume_outlines"] = [novel["volume_outline"]]
    novel["audit_outline_updated_at"] = datetime.datetime.now().isoformat()
    rewrite_indexes = _audit_rewrite_indexes(novel)
    rewritten_chapters = []
    with np.use_llm_settings(settings):
        for idx in rewrite_indexes:
            payload = _generate_chapter_payload(nid, novel, idx)
            rewritten_chapters.append({
                "chapter_index": payload["chapter_index"],
                "chapter_number": payload["chapter_number"],
                "chapter_title": payload["chapter_title"],
            })
    if rewritten_chapters:
        novel = _load(nid)
    _save(nid, novel)
    return {"ok": True, "updated": list(updated.keys()), "rewritten_chapters": rewritten_chapters, "novel": novel}


@app.post("/api/novels/{nid}/expand-outline")
def expand_outline(nid: str, body: ExpandReq, request: Request):
    """AI 续写 count 章章节大纲，追加到 outline 并保存。"""
    novel = _load(nid)
    count = max(1, min(int(body.count or 5), 20))  # 限制 1-20，避免超长请求
    settings = _settings_from_headers(request.headers)

    state = {
        "user_idea": novel.get("idea", ""),
        "world_setting": novel.get("world_setting", {}),
        "characters": novel.get("characters", []),
        "volume_outline": novel.get("volume_outline", {}),
        "pacing_outline": novel.get("pacing_outline", []),
        "story_bible": novel.get("story_bible", {}),
        "outline": novel.get("outline", []),
    }
    with np.use_llm_settings(settings):
        new_chapters = np.expand_chapter_outlines(state, count)

    outline = list(novel.get("outline", []))
    outline.extend(new_chapters)
    novel["outline"] = outline
    novel["pacing_outline"] = np.sync_pacing_outline_for_outline({
        **state,
        "outline": outline,
        "pacing_outline": novel.get("pacing_outline", []),
    })
    _save(nid, novel)
    return {"added": len(new_chapters), "outline": outline, "pacing_outline": novel["pacing_outline"]}


@app.delete("/api/novels/{nid}")
def delete_novel(nid: str):
    nid = _validate_novel_id(nid)
    data = NOVEL_STORE.get_novel(nid)
    if data is not None:
        title = "".join(ch if ch.isalnum() else "_" for ch in data.get("title", nid))[:40].strip("_")
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = DELETED_NOVELS_DIR / f"{stamp}_{title or nid}_{nid}.json"
        _write_json_atomic(backup, data)
        _mark_generation_cancelled(nid, "小说已删除，生成任务已取消")
        NOVEL_STORE.delete_novel(nid)
        return {"ok": True, "backup": backup.name}
    return {"ok": True}


@app.post("/api/deleted-novels/{name}/restore")
def restore_deleted_novel(name: str):
    p = _deleted_path(name)
    data = json.loads(p.read_text(encoding="utf-8"))
    nid = (data.get("id") or uuid.uuid4().hex[:8]).strip()
    if not NOVEL_ID_RE.fullmatch(nid):
        nid = uuid.uuid4().hex[:8]
    if NOVEL_STORE.get_novel(nid) is not None:
        nid = uuid.uuid4().hex[:8]
    data["id"] = nid
    data.setdefault("title", "恢复的小说")
    data.setdefault("created_at", datetime.datetime.now().isoformat())
    _strip_runtime_fields(data)
    _save(nid, _ensure_novel_defaults(data))
    p.unlink()
    return {"ok": True, "id": nid}


@app.delete("/api/deleted-novels/{name}")
def purge_deleted_novel(name: str):
    p = _deleted_path(name)
    p.unlink()
    return {"ok": True}


@app.post("/api/restore-novel")
def restore_novel(body: RestoreNovelReq):
    data = body.model_dump()
    nid = (data.get("id") or uuid.uuid4().hex[:8]).strip()
    if not nid:
        nid = uuid.uuid4().hex[:8]
    _validate_novel_id(nid)
    data["id"] = nid
    data.setdefault("title", "恢复的小说")
    data.setdefault("created_at", datetime.datetime.now().isoformat())
    _strip_runtime_fields(data)
    _save(nid, _ensure_novel_defaults(data))
    return {"ok": True, "id": nid}


@app.post("/api/novels/{nid}/generate-chapter/{idx}")
def generate_chapter(nid: str, idx: int, request: Request):
    novel = _load(nid)
    if idx < 0 or idx >= len(novel.get("outline", [])):
        raise HTTPException(400, "章节索引超出范围")

    settings = _settings_from_headers(request.headers)
    with np.use_llm_settings(settings):
        return _generate_chapter_payload(nid, novel, idx)


@app.post("/api/novels/{nid}/rewrite-chapter/{idx}")
def rewrite_chapter(nid: str, idx: int, body: RewriteReq, request: Request):
    novel = _load(nid)
    if idx < 0 or idx >= len(novel.get("outline", [])):
        raise HTTPException(400, "章节索引超出范围")
    chapters = list(novel.get("chapters", []))
    if idx >= len(chapters) or not chapters[idx].strip():
        raise HTTPException(400, "本章还没有正文，不能重写")

    settings = _settings_from_headers(request.headers)
    with np.use_llm_settings(settings):
        state = _chapter_state(novel, idx)
        state["current_draft"] = chapters[idx]
        state["review_issues"] = ["用户要求重写本章"]
        state["review_suggestions"] = [body.instructions.strip() or "在保持大纲不变的前提下提升章节质量"]

        result = np.revise_chapter(state)
        state.update(result)
        rv = np.review_chapter(state)
        state.update(rv)
        while not state.get("review_pass", True) and state.get("rewrite_count", 0) < 3:
            state.update(np.revise_chapter(state))
            state.update(np.review_chapter(state))
        state.update(np.continuity_check(state))
        if not state.get("continuity_pass", True) and state.get("rewrite_count", 0) < 3:
            state.update(np.revise_chapter(state))
            state.update(np.review_chapter(state))
            state.update(np.continuity_check(state))
        state.update(np.update_story_bible(state))

        draft, repair_state, alignment_issues = _repair_chapter_alignment(
            novel, idx, state.get("current_draft", ""), np
        )
    if alignment_issues:
        state.update(repair_state)
    chapters[idx] = draft
    novel["chapters"] = chapters
    novel["story_bible"] = state.get("story_bible", novel.get("story_bible", {}))
    _save(nid, novel)
    return {
        "chapter_index": idx,
        "draft": draft,
        "review": {"scores": state.get("review_scores", {}), "pass": state.get("review_pass", True), "feedback": state.get("review_feedback", "")},
        "outline_alignment_repaired": bool(alignment_issues),
        "outline_alignment_issues": alignment_issues,
    }


def _generation_job_id(nid: str) -> str:
    return f"gen-{nid}"


def _generation_progress_for_job(job: dict | None) -> dict:
    progress = {
        "status": "idle",
        "current": None,
        "completed": 0,
        "total": 0,
        "errors": [],
        "notes": [],
    }
    if not job:
        return progress
    result = job.get("result") or {}
    if isinstance(result, dict):
        progress.update(result)
    progress["status"] = job.get("status") or progress["status"]
    progress["message"] = job.get("message", "")
    if job.get("error"):
        progress["error"] = job["error"]
    if progress["status"] in ("done", "error", "cancelled"):
        progress["current"] = None
    return progress


def _mark_generation_cancelled(nid: str, message: str = "生成任务已取消"):
    job_id = _generation_job_id(nid)
    job = NOVEL_STORE.get_job(job_id)
    if not job or job.get("status") not in ("queued", "running"):
        return
    progress = _generation_progress_for_job(job)
    progress.update({"status": "cancelled", "current": None, "message": message})
    NOVEL_STORE.update_job(
        job_id,
        status="cancelled",
        message=message,
        result=progress,
    )


def _generate_remaining_worker(
    job_id: str, nid: str, settings: np.LLMSettings
):
    progress = {
        "status": "running",
        "current": None,
        "completed": 0,
        "total": 0,
        "errors": [],
        "notes": [],
    }
    try:
        with np.use_llm_settings(settings):
            novel = _load(nid)
            outline = novel.get("outline", [])
            chapters = list(novel.get("chapters", []))
            targets = [i for i in range(len(outline)) if i >= len(chapters) or not (chapters[i] or "").strip()]
            progress["total"] = len(targets)
            if NOVEL_STORE.is_cancelled(job_id):
                return
            NOVEL_STORE.update_job(
                job_id,
                status="running",
                message="正在生成剩余章节...",
                result=progress,
            )
            for done, idx in enumerate(targets, start=1):
                if NOVEL_STORE.is_cancelled(job_id):
                    return
                progress["current"] = idx
                NOVEL_STORE.update_job(job_id, result=progress)
                try:
                    novel = _load(nid)
                    result = np.run_single_chapter(_chapter_state(novel, idx))
                    draft = _save_chapter_result(nid, novel, idx, result)
                    reason = _chapter_repetition_reason(novel, idx, draft)
                    if reason:
                        progress.setdefault("notes", []).append(f"第{idx + 1}章触发重写：{reason}")
                        novel = _load(nid)
                        draft, state, _ = _repair_chapter_alignment(novel, idx, draft, np, reason)
                        chapters_now = list(novel.get("chapters", []))
                        while len(chapters_now) <= idx:
                            chapters_now.append("")
                        chapters_now[idx] = state.get("current_draft", "")
                        novel["chapters"] = chapters_now
                        novel["story_bible"] = state.get("story_bible", novel.get("story_bible", {}))
                        _save(nid, novel)
                except Exception as e:
                    progress.setdefault("errors", []).append(f"第{idx + 1}章：{e}")
                progress["completed"] = done
                if NOVEL_STORE.is_cancelled(job_id):
                    return
                NOVEL_STORE.update_job(job_id, result=progress)
        progress["current"] = None
        progress["status"] = "done"
        NOVEL_STORE.update_job(
            job_id,
            status="done",
            message="剩余章节生成完成",
            result=progress,
        )
    except Exception as e:
        traceback.print_exc()
        progress["status"] = "error"
        progress["current"] = None
        progress.setdefault("errors", []).append(str(e))
        NOVEL_STORE.update_job(
            job_id,
            status="error",
            error=_error_detail(e),
            message="生成剩余章节失败",
            result=progress,
        )


@app.post("/api/novels/{nid}/generate-remaining")
def generate_remaining(nid: str, request: Request):
    _load(nid)
    settings = _settings_from_headers(request.headers)
    job_id = _generation_job_id(nid)
    job = NOVEL_STORE.get_job(job_id)
    with _ACTIVE_JOBS_LOCK:
        is_active = job_id in _ACTIVE_JOBS
    if is_active and job and job.get("status") in ("queued", "running"):
        return {"ok": True, "status": "already_running"}
    NOVEL_STORE.upsert_job(
        job_id,
        kind="generate",
        status="queued",
        novel_id=nid,
        message="任务已排队",
    )
    if not _start_background_job(
        job_id, _generate_remaining_worker, job_id, nid, settings
    ):
        return {"ok": True, "status": "already_running"}
    return {"ok": True, "status": "queued"}


@app.get("/api/novels/{nid}/generation-progress")
def generation_progress(nid: str):
    _validate_novel_id(nid)
    return _generation_progress_for_job(
        NOVEL_STORE.get_job(_generation_job_id(nid))
    )


@app.post("/api/novels/{nid}/cancel-generation")
def cancel_generation(nid: str):
    _validate_novel_id(nid)
    _mark_generation_cancelled(nid)
    return {"ok": True}


STATIC_DIR = HERE / "static"
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


SKIN_TEMPLATES = {
    "base": "base.html",
    "longform": "index.html",
    "poetic": "theme-poetic.html",
    "editorial": "theme-editorial.html",
    "anime": "theme-anime.html",
    "oriental": "theme-oriental.html",
}


@app.get("/{path:path}")
async def index(request: Request, path: str = ""):
    """Serve the selected complete interface after every API route is registered."""
    if path.startswith("api/") or path.startswith("openapi") or path in ("docs", "redoc"):
        raise HTTPException(404)
    skin = request.query_params.get("skin", "longform").strip()
    template_name = SKIN_TEMPLATES.get(skin, "index.html")
    return HTMLResponse(
        (HERE / "templates" / template_name).read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store"},
    )
