import { readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_INTERNAL_API_BASE_URL, LOOPBACK_HOST } from "./consts";

/**
 * The platform's own API binds IPv4 only in production (`api.host` is
 * "0.0.0.0" in the backend config), so a URL that reaches it through the name
 * `localhost` always tries `::1` first — an address with no listener. That is
 * the `ECONNREFUSED ::1:9000` behind issues #4917 and #6933.
 *
 * Every self-directed dial therefore names {@link LOOPBACK_HOST}. This test is
 * the net under the ones that have their own assertion (`buildProxyBaseUrl` in
 * llm-client.test.ts, the frontend defaults in config.test.ts): it fails if any
 * source file grows a new URL pointing at our API port through a name.
 *
 * Two spellings are rejected: the API port written out, and a computed port.
 * `localhost` is the right answer for services on the *user's* machine — an
 * Ollama server, the OTLP collector, an OAuth callback — and those are always
 * written with their own literal port (11434, 4318), never a computed one, so
 * a computed port next to `localhost` in this repo is a self-dial.
 *
 * A net, not a proof: a self-dial assembled from variables slips past it. The
 * per-site assertions in llm-client.test.ts, next-config.test.ts,
 * config.test.ts and proxy.test.ts are what pin the sites that exist today.
 */
const SELF_DIAL_BY_NAME = /["'`](?:https?|wss?):\/\/localhost:(?:9000|\$\{)/;

/**
 * The code that runs *inside* the image. The whole `frontend` package, not just
 * its `src`, because next.config.ts is where the /api proxy destination is
 * baked into routes-manifest.json — the path the bug was actually reported on.
 *
 * `e2e-tests/` is deliberately absent: those URLs are dialled from the host by
 * the runner and the browser, where `localhost` is an origin identity rather
 * than a route — the lite suite's Keycloak redirect URI depends on it (see
 * platform-e2e-tests.yml).
 *
 * `@archestra/shared#check:ci` declares these trees as turbo inputs, so a
 * change to any of them re-runs this test instead of restoring a cache entry.
 */
const SCANNED_ROOTS = ["backend/src", "frontend", "shared"] as const;

const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".next-pw",
  ".turbo",
  "test-results",
]);

describe("loopback dial hygiene", () => {
  it("reaches the API through an address, not a name", () => {
    // The property that matters is resolver-independence: an address literal
    // has exactly one interpretation, a name has as many as /etc/hosts and
    // RFC 6724 give it.
    expect(isIP(LOOPBACK_HOST)).toBe(4);
    expect(isIP(new URL(DEFAULT_INTERNAL_API_BASE_URL).hostname)).toBe(4);
  });

  it("has no source file dialling the platform's own API port by name", () => {
    const platformRoot = resolve(import.meta.dirname, "..");
    const offenders: string[] = [];

    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(join(platformRoot, root))) {
        const contents = readFileSync(file, "utf-8");
        for (const [index, line] of contents.split("\n").entries()) {
          if (SELF_DIAL_BY_NAME.test(line)) {
            offenders.push(
              `${relative(platformRoot, file)}:${index + 1}: ${line.trim()}`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      "These URLs reach the platform's own API, which listens on IPv4 only, " +
        `through a name that resolves to ::1 first. Use LOOPBACK_HOST / ` +
        `DEFAULT_INTERNAL_API_BASE_URL from @archestra/shared/consts:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

/** Every non-test TypeScript file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Fixtures and expectations legitimately spell out a user-supplied
    // `http://localhost:9000` — what is under test there is our handling of an
    // operator's value, not an address we dial.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;

    found.push(path);
  }

  return found;
}
