from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


NOVEL_ID_RE = re.compile(r"^[0-9a-f]{8}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class NovelStore:
    """Small SQLite store for novels and durable background jobs."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS novels (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    novel_id TEXT,
                    payload TEXT NOT NULL DEFAULT '{}',
                    result TEXT,
                    error TEXT,
                    message TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_jobs_status
                ON jobs(status, updated_at);
                """
            )

    def get_novel(self, novel_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT data FROM novels WHERE id = ?", (novel_id,)
            ).fetchone()
        return json.loads(row["data"]) if row else None

    def save_novel(self, novel_id: str, data: dict) -> None:
        now = utc_now()
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        created_at = str(data.get("created_at") or now)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO novels(id, data, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    data = excluded.data,
                    updated_at = excluded.updated_at
                """,
                (novel_id, payload, created_at, now),
            )

    def delete_novel(self, novel_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT data FROM novels WHERE id = ?", (novel_id,)
            ).fetchone()
            if row:
                connection.execute("DELETE FROM novels WHERE id = ?", (novel_id,))
        return json.loads(row["data"]) if row else None

    def list_novels(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT data FROM novels ORDER BY updated_at DESC"
            ).fetchall()
        return [json.loads(row["data"]) for row in rows]

    def import_json_dir(self, directory: Path | str) -> int:
        directory = Path(directory)
        if not directory.exists():
            return 0
        imported = 0
        for path in directory.glob("*.json"):
            if not NOVEL_ID_RE.fullmatch(path.stem):
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    continue
                novel_id = path.stem
                if self.get_novel(novel_id) is not None:
                    continue
                data["id"] = novel_id
                self.save_novel(novel_id, data)
                imported += 1
            except (OSError, ValueError, TypeError):
                continue
        return imported

    def upsert_job(
        self,
        job_id: str,
        *,
        kind: str,
        status: str = "queued",
        novel_id: str | None = None,
        payload: dict | None = None,
        message: str = "",
    ) -> dict:
        now = utc_now()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs(
                    id, kind, status, novel_id, payload, message, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    status = excluded.status,
                    novel_id = excluded.novel_id,
                    payload = excluded.payload,
                    result = NULL,
                    error = NULL,
                    message = excluded.message,
                    updated_at = excluded.updated_at
                """,
                (
                    job_id,
                    kind,
                    status,
                    novel_id,
                    payload_json,
                    message,
                    now,
                    now,
                ),
            )
        return self.get_job(job_id) or {}

    def update_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        novel_id: str | None = None,
        result: dict | None = None,
        error: str | None = None,
        message: str | None = None,
    ) -> None:
        fields = ["updated_at = ?"]
        values: list[object] = [utc_now()]
        if status is not None:
            fields.append("status = ?")
            values.append(status)
        if novel_id is not None:
            fields.append("novel_id = ?")
            values.append(novel_id)
        if result is not None:
            fields.append("result = ?")
            values.append(json.dumps(result, ensure_ascii=False))
        if error is not None:
            fields.append("error = ?")
            values.append(error)
        if message is not None:
            fields.append("message = ?")
            values.append(message)
        values.append(job_id)
        with self._connect() as connection:
            connection.execute(
                f"UPDATE jobs SET {', '.join(fields)} WHERE id = ?", values
            )

    def get_job(self, job_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return self._job_from_row(row) if row else None

    def list_jobs(self, statuses: tuple[str, ...] | None = None) -> list[dict]:
        query = "SELECT * FROM jobs"
        values: list[object] = []
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            query += f" WHERE status IN ({placeholders})"
            values.extend(statuses)
        query += " ORDER BY created_at"
        with self._connect() as connection:
            rows = connection.execute(query, values).fetchall()
        return [self._job_from_row(row) for row in rows]

    def requeue_running_jobs(self) -> int:
        now = utc_now()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE jobs
                SET status = 'queued',
                    message = '服务重启后已重新排队',
                    updated_at = ?
                WHERE status = 'running'
                """,
                (now,),
            )
        return cursor.rowcount

    def is_cancelled(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        return bool(job and job.get("status") == "cancelled")

    @staticmethod
    def _job_from_row(row: sqlite3.Row) -> dict:
        job = dict(row)
        job["payload"] = json.loads(job.get("payload") or "{}")
        job["result"] = json.loads(job["result"]) if job.get("result") else None
        return job
