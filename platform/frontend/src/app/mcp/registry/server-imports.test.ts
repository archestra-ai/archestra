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
  // The shell seed keys its reads with these modules' query keys.
  "lib/agent-runs-query-keys.ts",
  "lib/app.query.ts",
  "lib/auth/auth.query.ts",
  "lib/chat/conversations-query-key.ts",
  "lib/chat/new-chat-seed.ts",
  "lib/environment.query.ts",
  "lib/projects/projects.query.ts",
  "lib/site-notification.query.ts",
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
    const used = reactValuesUsed(source);

    expect(used.filter((name) => !(name in reactServer))).toEqual([]);
  });

  it("finds every way a module can reach a React value", () => {
    expect(
      reactValuesUsed(`
        import React, {
          useMemo,
          type ReactNode,
          useRef as useBox,
        } from "react";
        import type { FC } from "react";
        import * as R from 'react';
        const a = React.useState(0);
        const b = R.useId();
      `).sort(),
    ).toEqual(["useId", "useMemo", "useRef", "useState"]);
  });
});

/**
 * The React values a module uses: named imports (multi-line, after a default
 * import, aliased), and members read through a default or namespace import.
 * Type-only imports and capitalised names (types, components) are skipped.
 */
function reactValuesUsed(source: string): string[] {
  const values = new Set<string>();
  const handles: string[] = [];
  for (const match of source.matchAll(
    /import\s+(type\s+)?([^;]*?)\s*from\s*["']react["']/g,
  )) {
    if (match[1]) continue;
    const clause = match[2] ?? "";
    for (const name of /\{([^}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
      const imported = name
        .replace(/^\s*type\s+.*$/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (imported && !/^[A-Z]/.test(imported)) values.add(imported);
    }
    const handle = /^(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/.exec(
      clause.trim(),
    )?.[1];
    if (handle) handles.push(handle);
  }
  for (const handle of handles) {
    for (const match of source.matchAll(
      new RegExp(`\\b${handle}\\.([a-z][\\w$]*)`, "g"),
    )) {
      if (match[1]) values.add(match[1]);
    }
  }
  return [...values];
}
