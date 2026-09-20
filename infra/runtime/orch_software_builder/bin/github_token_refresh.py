"""Keep a private, job-scoped Git credential fresh during long-running builds."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import tempfile
import threading
from datetime import datetime, timezone
from typing import Callable

from software_github_credentials import RepositoryCredentials, _validate_credentials

LOG = logging.getLogger(__name__)
REFRESH_MARGIN_SECONDS = 300
RETRY_SECONDS = 60


def refresh_delay(credentials: RepositoryCredentials) -> float:
    expiry = datetime.fromisoformat(credentials.expires_at.replace("Z", "+00:00"))
    return max(0, (expiry - datetime.now(timezone.utc)).total_seconds() - REFRESH_MARGIN_SECONDS)


def write_credentials(path: Path, credentials: RepositoryCredentials, job_id: str,
                      orchestrator_id: str) -> None:
    payload = {
        "job_id": job_id,
        "orchestrator_instance_id": orchestrator_id,
        "credentials": {
            "token": credentials.token,
            "expires_at": credentials.expires_at,
            "repository": {"id": credentials.repository_id, "fullName": credentials.repository_full_name},
            "permissions": {"contents": "write", "metadata": "read"},
        },
    }
    descriptor, temporary_name = tempfile.mkstemp(prefix=".github-token-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def read_credentials(path: Path, job_id: str, orchestrator_id: str) -> RepositoryCredentials | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload["job_id"] != job_id or payload["orchestrator_instance_id"] != orchestrator_id:
            return None
        credentials = _validate_credentials(payload["credentials"])
        return credentials if refresh_delay(credentials) > 0 else None
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        return None


class GitHubTokenRefresher:
    def __init__(self, *, path: Path, initial: RepositoryCredentials, job_id: str,
                 orchestrator_id: str, fetch: Callable[[], RepositoryCredentials]):
        self.path = path
        self.credentials = initial
        self.job_id = job_id
        self.orchestrator_id = orchestrator_id
        self.fetch = fetch
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self._run, name="github-token-refresh", daemon=True)

    def start(self) -> None:
        write_credentials(self.path, self.credentials, self.job_id, self.orchestrator_id)
        self.thread.start()

    def _run(self) -> None:
        delay = refresh_delay(self.credentials)
        while not self.stopping.wait(delay):
            try:
                fresh = self.fetch()
                if (fresh.repository_id != self.credentials.repository_id
                        or fresh.repository_full_name != self.credentials.repository_full_name):
                    raise RuntimeError("GitHub refresh changed repository assignment")
                if self.stopping.is_set():
                    return
                write_credentials(self.path, fresh, self.job_id, self.orchestrator_id)
                self.credentials = fresh
                LOG.info("Refreshed GitHub write credential; expires at %s", fresh.expires_at)
                delay = max(RETRY_SECONDS, refresh_delay(fresh))
            except Exception:
                # Do not log exceptions or broker payloads that might contain secrets.
                LOG.warning("Scheduled GitHub credential refresh failed; retrying in 60 seconds")
                delay = RETRY_SECONDS

    def stop(self) -> None:
        self.stopping.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=65)
        self.path.unlink(missing_ok=True)
