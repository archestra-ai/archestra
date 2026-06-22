// biome-ignore-all lint/suspicious/noExplicitAny: test
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type OpenApiDoc,
  projectCompactOpenApi,
} from "@/openapi/project-compact-openapi";
import { BUILT_IN_SKILLS } from "./built-in-skills";

// The committed, CI-kept-current spec (repo-root docs/openapi.json).
const here = dirname(fileURLToPath(import.meta.url));
const openApiPath = resolve(here, "../../../../docs/openapi.json");
const openApiDoc = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;
const apiGroups = new Set(
  Object.keys(openApiDoc.paths ?? {})
    .filter((p) => p.startsWith("/api/"))
    .map((p) => `/api/${p.split("/")[2]}`),
);

const skill = BUILT_IN_SKILLS.find(
  (s) => s.builtInSkillId === "archestra-platform-operations",
);
const skillText = [
  skill?.content ?? "",
  ...(skill?.files ?? []).map((f) => f.content),
].join("\n");

describe("Archestra Platform Operations skill", () => {
  test("exists", () => {
    expect(skill).toBeDefined();
  });

  test("every /api route group it names actually exists (drift guard)", () => {
    const mentioned = new Set(
      [...skillText.matchAll(/\/api\/[a-z0-9_-]+/gi)].map(
        (m) => `/api/${m[0].split("/")[2]}`,
      ),
    );
    // /openapi.json is the discovery route, not an /api group.
    const missing = [...mentioned].filter((g) => !apiGroups.has(g));
    expect(missing).toEqual([]);
  });

  test("teaches discovery via the compact archestra__api path", () => {
    expect(skillText).toContain("/openapi.json?compact=1");
    expect(skillText).toContain("archestra__api");
  });

  test("keeps deploy_mcp_server as the documented non-REST exception", () => {
    expect(skillText).toContain("archestra__deploy_mcp_server");
  });
});

describe("compact projection on the real spec", () => {
  test("is a fraction of the full spec but covers every /api group", () => {
    const compact = projectCompactOpenApi(openApiDoc);
    const compactBytes = JSON.stringify(compact).length;
    const fullBytes = JSON.stringify(openApiDoc).length;
    expect(compactBytes).toBeLessThan(fullBytes / 5);
    expect(Object.keys(compact.paths ?? {}).length).toBe(
      Object.keys(openApiDoc.paths ?? {}).filter((p) => p.startsWith("/api/"))
        .length,
    );
  });

  test("preserves x-required-permissions and drops responses on a real op", () => {
    const compact = projectCompactOpenApi(openApiDoc, {
      pathPrefix: "/api/agents",
    });
    const ops = Object.values(
      (compact.paths?.["/api/agents"] as Record<string, any>) ?? {},
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops as Record<string, unknown>[]) {
      expect(op["x-required-permissions"]).toBeDefined();
      expect(op.responses).toBeUndefined();
    }
  });
});
