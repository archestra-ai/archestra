// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Modules the registry page's server components import (the page, and the
 * root layout's shell seed). React's server build has no state or ref hooks,
 * so one stray client hook here fails the page to compile; unit tests run the
 * client build and would not notice.
 */
const SERVER_IMPORTED_MODULES = [
  "lib/mcp/mcp-registry.query.ts",
  "lib/auth/shell-seed.server.ts",
  "lib/auth/shell-seed.ts",
  "app/mcp/registry/prefetch-first-page.ts",
  "components/table-card-view.server.ts",
];

describe("modules the registry's server components import", () => {
  const require = createRequire(import.meta.url);
  const reactServer = require(
    path.join(
      path.dirname(require.resolve("react/package.json")),
      "react.react-server.js",
    ),
  ) as Record<string, unknown>;

  it.each(
    SERVER_IMPORTED_MODULES,
  )("%s imports from React only what its server build has", (modulePath) => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../../..", modulePath),
      "utf8",
    );
    const imported = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"react"/g),
    ].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((name) => name.replace(/^\s*type\s+/, "").trim())
        .filter((name) => name && !/^[A-Z]/.test(name)),
    );

    expect(imported.filter((name) => !(name in reactServer))).toEqual([]);
  });
});
