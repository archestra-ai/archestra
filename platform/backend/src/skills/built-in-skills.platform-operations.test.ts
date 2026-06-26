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
const realApiPaths = Object.keys(openApiDoc.paths ?? {}).filter((p) =>
  p.startsWith("/api/"),
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

  test("every /api path it names is a real route (drift guard)", () => {
    // Concrete routes (deeper than /api/<group>, e.g.
    // /api/autonomy-policies/tool-invocation) must match a real route exactly —
    // that is what catches "named a real group but the wrong sub-route". Group
    // roots are orientation, so a prefix match is enough for them. The regex
    // stops at `:`, so `:param` paths collapse to their group root.
    const realPaths = new Set(realApiPaths);
    const collectionRoots = new Set(
      realApiPaths.map((p) => p.replace(/\/\{[^}]+\}$/, "")),
    );
    const depth = (p: string) => p.split("/").filter(Boolean).length;
    const mentioned = new Set(
      [...skillText.matchAll(/\/api\/[a-z0-9_/-]+/gi)].map((m) =>
        m[0].replace(/\/$/, ""),
      ),
    );
    const unmatched = [...mentioned].filter((tok) =>
      depth(tok) <= 2
        ? !realApiPaths.some((rp) => rp === tok || rp.startsWith(`${tok}/`))
        : !(realPaths.has(tok) || collectionRoots.has(tok)),
    );
    expect(unmatched).toEqual([]);
  });

  test("teaches discovery via the compact archestra__api path", () => {
    expect(skillText).toContain("/api/openapi-compact");
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
