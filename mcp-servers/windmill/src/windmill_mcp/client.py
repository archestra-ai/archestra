"""Windmill REST API client."""
from __future__ import annotations

import os
from typing import Any

import httpx


class WindmillError(Exception):
    """Raised when the Windmill API returns an error."""

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        super().__init__(f"Windmill API error {status_code}: {message}")


class WindmillClient:
    """Thin async wrapper around the Windmill REST API.

    Configuration is read from environment variables:
        WINDMILL_BASE_URL  – base URL of the Windmill instance
                             (e.g. https://app.windmill.dev or http://localhost:8000)
        WINDMILL_TOKEN     – API token (create one in Windmill → Account → Tokens)
        WINDMILL_WORKSPACE – workspace slug (e.g. "my-org")
    """

    def __init__(self) -> None:
        self.base_url = os.environ["WINDMILL_BASE_URL"].rstrip("/")
        self.token = os.environ["WINDMILL_TOKEN"]
        self.workspace = os.environ["WINDMILL_WORKSPACE"]
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=30.0,
            trust_env=False,  # Ignore system proxy settings
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _get(self, path: str, **params: Any) -> Any:
        resp = await self._client.get(path, params=params or None)
        self._raise_for_status(resp)
        return resp.json()

    async def _post(self, path: str, json: Any = None, timeout: float | None = None) -> Any:
        """POST helper.

        Args:
            timeout: Per-request timeout in seconds. When provided it overrides
                     the client-level default (30 s) for this call only.
        """
        resp = await self._client.post(path, json=json, timeout=timeout)
        self._raise_for_status(resp)
        # Some endpoints return plain text (job ID)
        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            return resp.json()
        return resp.text

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if resp.is_error:
            try:
                detail = resp.json().get("detail") or resp.text
            except Exception:
                detail = resp.text
            raise WindmillError(resp.status_code, detail)

    # ------------------------------------------------------------------
    # Flows
    # ------------------------------------------------------------------

    async def list_flows(self, page: int = 1, per_page: int = 50) -> list[dict]:
        """Return all flows in the workspace."""
        return await self._get(
            f"/api/w/{self.workspace}/flows/list",
            page=page,
            per_page=per_page,
        )

    async def get_flow(self, path: str) -> dict:
        """Return the full definition of a flow."""
        return await self._get(f"/api/w/{self.workspace}/flows/get/{path}")

    async def run_flow(self, path: str, args: dict[str, Any] | None = None) -> str:
        """Trigger a flow run and return the job ID."""
        result = await self._post(
            f"/api/w/{self.workspace}/jobs/run/f/{path}",
            json=args or {},
        )
        # Returns the job UUID as a plain string
        return str(result).strip('"')

    async def run_flow_and_wait(
        self, path: str, args: dict[str, Any] | None = None, timeout: int = 60
    ) -> dict:
        """Trigger a flow and block until it completes (up to `timeout` seconds).

        The per-request timeout is set to ``timeout`` seconds, overriding the
        client-level 30 s default so flows that take up to 60 s complete
        successfully instead of raising ``ReadTimeout``.
        """
        result = await self._post(
            f"/api/w/{self.workspace}/jobs/run_wait_result/f/{path}",
            json=args or {},
            timeout=float(timeout),
        )
        return result  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    async def list_jobs(self, page: int = 1, per_page: int = 20) -> list[dict]:
        """Return recent completed jobs."""
        return await self._get(
            f"/api/w/{self.workspace}/jobs_u/completed/list",
            page=page,
            per_page=per_page,
        )

    async def get_job(self, job_id: str) -> dict:
        """Return a job (running or completed).

        Uses the /jobs_u/ (user-accessible) endpoint — /jobs/ is admin-only
        and returns 404 for regular user tokens.
        """
        return await self._get(f"/api/w/{self.workspace}/jobs_u/get/{job_id}")

    async def get_job_result(self, job_id: str) -> Any:
        """Return the result payload of a completed job."""
        return await self._get(f"/api/w/{self.workspace}/jobs_u/completed/result/{job_id}")

    # ------------------------------------------------------------------
    # Scripts
    # ------------------------------------------------------------------

    async def list_scripts(self, page: int = 1, per_page: int = 50) -> list[dict]:
        """Return all scripts in the workspace."""
        return await self._get(
            f"/api/w/{self.workspace}/scripts/list",
            page=page,
            per_page=per_page,
        )

    # ------------------------------------------------------------------
    # Editor URL (used for MCP Apps display in Archestra)
    # ------------------------------------------------------------------

    def flow_editor_url(self, path: str) -> str:
        """Return the Windmill flow-editor URL for a given flow path.

        Archestra renders this URL inside an iframe as an interactive
        MCP App, allowing users to visually inspect and edit workflow nodes.
        """
        return f"{self.base_url}/flows/edit/{path}?workspace={self.workspace}"

    async def close(self) -> None:
        await self._client.aclose()
