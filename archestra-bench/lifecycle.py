"""Spawn and tear down a fresh, isolated Archestra backend for one benchmark run.

The harness does NOT run its own Tilt stack. It reuses the developer's already-running stack's
shared services -- Postgres (host-reachable) and the Dagger code-runtime engine -- and only stands
up the one thing it needs isolated: a fresh database (migrated from scratch) plus a second backend
*process* on a new port pointing at it. The main dev stack, its database, and `platform/.env` are
never touched.

Why this works without a worktree or a second Tilt: the backend reads `process.env` directly, so a
directly-spawned backend honours benchmark overrides (fresh DB URL, new API port) that a second
Tilt could not -- Tilt's `dotenv('./.env')` overrides process env, and editing the shared `.env`
would restart the main stack.

Teardown always runs: the backend process group is killed and the benchmark database is dropped.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import signal
import socket
import subprocess
import time
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import psycopg
from psycopg import sql

from eval_client import EvalClient

logger = logging.getLogger(__name__)

_DAGGER_RUNNER_HOST = "tcp://127.0.0.1:1234"  # the shared engine the main stack port-forwards
_DEV_AUTH_SECRET = "better-auth-secret-12345678901234567890"  # matches the Tiltfile dev default
_DEFAULT_ADMIN_EMAIL = "admin@example.com"
_DEFAULT_ADMIN_PASSWORD = "password"


@dataclass
class Instance:
    """A fresh backend on a new port over a fresh database. Use as a context manager.

    On enter: create the database, migrate it, spawn the backend, wait for readiness, sign in the
    seeded admin, and mint an api key. On exit: kill the backend process group and drop the database.
    """

    repo_root: Path
    run_id: str
    log_path: Path
    ready_timeout_s: float = 300.0
    base_url: str = field(init=False, default="")
    client: EvalClient = field(init=False)
    _proc: subprocess.Popen[bytes] | None = field(init=False, default=None)
    _db_name: str = field(init=False, default="")
    _database_created: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        self._platform = self.repo_root / "platform"
        self._env = parse_env_file(self._platform / ".env")
        self._maint_db_url = self._env["ARCHESTRA_DATABASE_URL"]
        self._db_name = benchmark_db_name(self.run_id)
        self._db_url = with_dbname(self._maint_db_url, self._db_name)
        self._api_port = _free_port()
        self._metrics_port = _free_port()

    def __enter__(self) -> "Instance":
        try:
            self._create_database()
            self._migrate()
            self._spawn_backend()
            self._connect()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *exc: object) -> None:
        try:
            self._kill_backend()
        finally:
            self._drop_database()

    # === setup steps ===

    def _create_database(self) -> None:
        logger.info("creating benchmark database %s", self._db_name)
        try:
            with psycopg.connect(libpq_url(self._maint_db_url), autocommit=True) as conn:
                conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(self._db_name)))
        except psycopg.OperationalError as exc:
            raise RuntimeError(shared_postgres_unavailable_message(self._maint_db_url)) from exc
        self._database_created = True

    def _migrate(self) -> None:
        logger.info("migrating %s", self._db_name)
        env = self._backend_env()
        proc = subprocess.run(
            ["pnpm", "--filter", "@backend", "db:migrate"],
            cwd=str(self._platform),
            env=env,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"db:migrate failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}")

    def _spawn_backend(self) -> None:
        # Run the already-built server the main stack keeps fresh (tsdown --watch), rather than a
        # second builder: two `tsdown --watch` on the same dist/ would clobber the main stack.
        backend_dir = self._platform / "backend"
        server_bundle = backend_dir / "dist" / "server.mjs"
        if not server_bundle.exists():
            raise RuntimeError(f"{server_bundle} not found; is the main dev stack built and running?")
        self.base_url = f"http://localhost:{self._api_port}"
        logger.info("spawning backend on %s (log: %s)", self.base_url, self.log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log = self.log_path.open("wb")
        self._proc = subprocess.Popen(
            ["node", "dist/server.mjs"],
            cwd=str(backend_dir),
            env=self._backend_env(),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # own process group so teardown kills the whole tree
        )

    def _connect(self) -> None:
        self.client = EvalClient(self.base_url)
        deadline = time.monotonic() + self.ready_timeout_s
        while True:
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError(f"backend exited early (code {self._proc.returncode}); see {self.log_path}")
            # wait_ready polls internally and raises TimeoutError while the server is still booting
            # (connection-refused/5xx are transient); a 4xx misconfig raises ArchestraApiError and
            # is allowed to propagate. Loop on TimeoutError until our own (larger) deadline.
            try:
                self.client.wait_ready(timeout_s=5.0, interval_s=1.0)
                break
            except TimeoutError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"backend not ready in {self.ready_timeout_s}s; see {self.log_path}") from None
                time.sleep(2.0)
        email = self._env.get("ARCHESTRA_AUTH_ADMIN_EMAIL", _DEFAULT_ADMIN_EMAIL)
        password = self._env.get("ARCHESTRA_AUTH_ADMIN_PASSWORD", _DEFAULT_ADMIN_PASSWORD)
        self.client.sign_in(email, password)
        # mint_api_key switches the client from session/cookie auth to api-key auth for every
        # subsequent request. a short, fixed label: better-auth's apiKey plugin caps the name at 32
        # chars (maximumNameLength default), and each fresh db holds exactly one key.
        self.client.mint_api_key("archestra-bench")

    # === teardown steps ===

    def _kill_backend(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        logger.info("stopping backend pid %s", proc.pid)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)

    def _drop_database(self) -> None:
        if not self._database_created:
            return
        logger.info("dropping benchmark database %s", self._db_name)
        try:
            with psycopg.connect(libpq_url(self._maint_db_url), autocommit=True) as conn:
                conn.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
                    (self._db_name,),
                )
                conn.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(self._db_name)))
            self._database_created = False
        except psycopg.Error:
            logger.exception("failed to drop benchmark database %s", self._db_name)

    def _backend_env(self) -> dict[str, str]:
        return build_backend_env(
            base_env=self._env,
            db_url=self._db_url,
            api_base_url=f"http://localhost:{self._api_port}",
            metrics_port=self._metrics_port,
            dagger_cli_bin=str(self._platform / "dev" / "bin" / "dagger"),
        )


# === pure helpers (offline-testable) ===


_ENV_VAR_REF = re.compile(r"\$\{(\w+)\}|\$(\w+)")


def _expand_env_refs(value: str, lookup: Mapping[str, str]) -> str:
    """Expand `$VAR` / `${VAR}` references against `lookup`, undefined -> empty (shell semantics).

    The dotenv extension Tilt loads does not interpolate either, so a `.env` value like
    `$OPENROUTER_API_KEY` reaches the backend verbatim and is seeded as a bogus key; expanding here
    forwards the resolved secret instead."""
    return _ENV_VAR_REF.sub(lambda m: lookup.get(m.group(1) or m.group(2), ""), value)


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse a dotenv file: `KEY=VALUE` lines, quotes stripped, comments/blanks skipped, `$VAR`
    references expanded against the process env and earlier lines.

    The backend does not auto-load `.env` outside Tilt, so the harness loads it here and forwards it
    to the spawned backend."""
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        env[key.strip()] = _expand_env_refs(value.strip().strip('"').strip("'"), {**os.environ, **env})
    return env


def benchmark_db_name(run_id: str) -> str:
    """A unique, postgres-safe database name for this run."""
    safe = "".join(ch if ch.isalnum() else "_" for ch in run_id.lower()).strip("_")
    return f"archestra_bench_{safe or 'run'}"


def libpq_url(db_url: str) -> str:
    """A libpq-acceptable conninfo URL: the same postgres URL with non-libpq query params (e.g.
    the Prisma-style `?schema=public`) dropped, since libpq would reject unknown keywords."""
    return urllib.parse.urlparse(db_url)._replace(query="").geturl()


def with_dbname(db_url: str, dbname: str) -> str:
    """Return `db_url` with its database name replaced, preserving query params (e.g. ?schema=public)."""
    return urllib.parse.urlparse(db_url)._replace(path=f"/{dbname}").geturl()


def shared_postgres_unavailable_message(db_url: str) -> str:
    """Human-safe diagnostic for the shared Postgres dependency, without leaking credentials."""
    return (
        f"cannot connect to shared Archestra Postgres at {redacted_db_location(db_url)}; "
        "start the dev stack from platform/ with ARCHESTRA_CODE_RUNTIME_ENABLED=true and `tilt up`, "
        "or restore the configured Postgres port-forward"
    )


def redacted_db_location(db_url: str) -> str:
    parsed = urllib.parse.urlparse(db_url)
    host = parsed.hostname or "<unknown-host>"
    port = f":{parsed.port}" if parsed.port is not None else ""
    database = parsed.path.lstrip("/") or "<unknown-database>"
    return f"{host}{port}/{database}"


def build_backend_env(
    *,
    base_env: dict[str, str],
    db_url: str,
    api_base_url: str,
    metrics_port: int,
    dagger_cli_bin: str,
) -> dict[str, str]:
    """The environment for the spawned backend: the dev `.env` layered over the process env, then
    the benchmark overrides that isolate this instance (fresh DB + own ports + shared Dagger)."""
    env: dict[str, str] = {**os.environ, **base_env}
    env.setdefault("ARCHESTRA_AUTH_SECRET", _DEV_AUTH_SECRET)
    env.update(
        {
            "ARCHESTRA_DATABASE_URL": db_url,
            "ARCHESTRA_INTERNAL_API_BASE_URL": api_base_url,
            "ARCHESTRA_METRICS_PORT": str(metrics_port),
            "ARCHESTRA_CODE_RUNTIME_ENABLED": "true",
            "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST": _DAGGER_RUNNER_HOST,
            "ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN": dagger_cli_bin,
            "ARCHESTRA_ANALYTICS": "disabled",
        }
    )
    return env


# === internal ===


def _free_port() -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
