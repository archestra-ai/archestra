/**
 * Side-effect module for the T0 benchmark harness. Import it FIRST in any
 * bench script that pulls in the backend module graph: `@/config` requires a
 * database URL at import time. The URL below is never dialed by the
 * benchmarks — it only satisfies config validation.
 */
process.env.ARCHESTRA_DATABASE_URL ??=
  "postgres://bench:bench@127.0.0.1:5432/bench";
// Quiet per-message info logs from the adapter path during runs.
process.env.ARCHESTRA_LOGGING_LEVEL ??= "warn";
