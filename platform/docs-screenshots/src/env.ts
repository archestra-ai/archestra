import path from "node:path";

/**
 * Where to capture from and where to write. Every value can be overridden so the
 * same command works against local Tilt, the e2e-lite stack on CI, or any other
 * instance reachable over HTTP.
 */

/** The Archestra frontend; the API is reached through the same origin. */
export const ARCHESTRA_URL = (
  process.env.ARCHESTRA_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

/** An admin on the target instance, used only to seed. Captures run as the persona. */
export const ADMIN_EMAIL =
  process.env.ARCHESTRA_AUTH_ADMIN_EMAIL ?? "admin@example.com";
export const ADMIN_PASSWORD =
  process.env.ARCHESTRA_AUTH_ADMIN_PASSWORD ?? "password";

/** docs/assets: markdown embeds `/docs/<path>` resolve to `docs/assets/<path>`. */
export const DOCS_ASSETS_DIR = path.resolve(__dirname, "../../../docs/assets");

/** Comma-separated shot ids (or id prefixes) to capture; empty captures everything. */
export const ONLY = (process.env.DOCS_SCREENSHOTS_ONLY ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

/** Seed output (ids by name) and the persona's session, shared between projects. */
export const STATE_DIR = path.resolve(__dirname, "../.state");
export const SEED_STATE_FILE = path.join(STATE_DIR, "seed.json");
export const PERSONA_AUTH_FILE = path.join(STATE_DIR, "persona-auth.json");
