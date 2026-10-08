import { createHash, randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import type { RemediesView } from "@/types/openappa-remedies";
import routes from "./openappa-remedies.routes";

describe("GET /api/openappa/remedies", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
  });

  const view = async (): Promise<RemediesView> => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/remedies",
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const block = (body: RemediesView, kind: string) =>
    body.blocks.find((each) => each.kind === kind);
  // The view reads the text, whether or not the runtime composes it.
  const saveRoot = async (content: string) => {
    const latest = await guardrailsPolicyService.get(ctx.organizationId);
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      updatedBy: ctx.user.id,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      expectedRevision: latest.revision,
    });
  };
  /** The 1-based line of the n-th (from 1) occurrence of `line`. */
  const rootLine = (content: string, line: string, nth = 1) =>
    content
      .split("\n")
      .flatMap((each, index) => (each === line ? [index + 1] : []))[nth - 1];

  test("is not found while Guardrails v2 is disabled", async () => {
    config.openappa.enabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/remedies",
    });
    expect(response.statusCode).toBe(404);
  });

  test("reads root authorities with who runs them and what they permit", async () => {
    const content = `[policy]
version = 2

[[policy.tool]]
name = "mail__send"
requires = { trust = "trusted", audience = { contains = ["public"] }, attention = ["mail-review"] }
excludes = ["invoice.sent"]
tags = ["mail"]

[[policy.tool]]
name = "crm__delete"
requires = { attention = ["crm-review"] }

[[policy.authority]]
name = "human"
permits = { attention = ["*"], audience_missing = ["public"] }

[[policy.authority]]
name = "finance-officer"
tags = ["mail"]
permits = { trust_below = "trusted", effects_containing = ["invoice.sent"] }

[[policy.authority]]
name = "legal-reviewer"
permits = { attention = ["legal-signoff"] }

[externals.authorities.human]
builtin = "hitl"

[externals.authorities.finance-officer]
url = "https://approvals.corp/review"
`;
    await saveRoot(content);

    const body = await view();

    expect(body.sanitizers).toEqual([]);
    expect(body.authorities).toEqual([
      {
        kind: "authority",
        name: "human",
        source: {
          entry: null,
          battery: null,
          line: rootLine(content, "[[policy.authority]]"),
        },
        implementation: { kind: "hitl", detail: "hitl" },
        tags: [],
        permits: {
          attention: ["*"],
          audienceMissing: ["public"],
          trustBelow: null,
          effectsContaining: [],
        },
        lastConsult: null,
      },
      {
        kind: "authority",
        name: "finance-officer",
        source: {
          entry: null,
          battery: null,
          line: rootLine(content, "[[policy.authority]]", 2),
        },
        implementation: { kind: "url", detail: "approvals.corp" },
        tags: ["mail"],
        permits: {
          attention: [],
          audienceMissing: [],
          trustBelow: "trusted",
          effectsContaining: ["invoice.sent"],
        },
        lastConsult: null,
      },
      {
        kind: "authority",
        name: "legal-reviewer",
        source: {
          entry: null,
          battery: null,
          line: rootLine(content, "[[policy.authority]]", 3),
        },
        implementation: null,
        tags: [],
        permits: {
          attention: ["legal-signoff"],
          audienceMissing: [],
          trustBelow: null,
          effectsContaining: [],
        },
        lastConsult: null,
      },
    ]);
    expect(body.blocks).toEqual([
      {
        kind: "trust",
        rules: 1,
        approvers: 1,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "audience",
        rules: 1,
        approvers: 1,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "effects",
        rules: 1,
        approvers: 1,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "approvals",
        rules: 2,
        approvers: 1,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
    ]);
  });

  test("a mark no wired authority gives, and a block kind no remedy lifts, are uncovered", async () => {
    const content = `[policy]
version = 2

[[policy.tool]]
name = "web__fetch"
delta = { trust = "suspicious" }

[[policy.tool]]
name = "db__migrate"
requires = { trust = "trusted", attention = ["sre-signoff"] }

[[policy.tool]]
name = "mail__send"
requires = { attention = ["mail-review"] }

[[policy.authority]]
name = "sre-reviewer"
permits = { attention = ["sre-signoff"] }

[[policy.authority]]
name = "mail-reviewer"
permits = { attention = ["mail-review"] }

[externals.authorities.sre-reviewer]
builtin = "hitl"
`;
    await saveRoot(content);

    const body = await view();

    expect(block(body, "trust")).toMatchObject({
      rules: 1,
      approvers: 0,
      cleaners: 0,
      covered: false,
    });
    expect(block(body, "audience")).toMatchObject({ rules: 0, covered: true });
    expect(block(body, "approvals")).toMatchObject({
      rules: 2,
      approvers: 1,
      unservedMarks: ["mail-review"],
      covered: false,
    });
  });

  test("reads a battery's sanitizer with its file, transition and built-in", async () => {
    const { entry } = await openappaBatteriesService.uploadPackage({
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
      name: "support",
      files: [
        {
          path: "appa-package.toml",
          text: `schema = 1
name = "support"
description = "Support desk battery under test"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
namespaces = ["support"]
`,
        },
        {
          path: "appa.toml",
          text: `[policy]
version = 2

[[policy.tool]]
name = "mcp/support/get_ticket"
delta = { audience = ["internal"] }
tags = ["support"]

[[policy.sanitizer]]
name = "strip-customer-pii"
on = ["tool_output"]
tags = ["support"]

[policy.sanitizer.permits]
audience = { from = ["internal"], to = ["public"] }

[externals.sanitizers.strip-customer-pii]
builtin = "redact-email"
`,
        },
      ],
    });
    await saveRoot(`include = ["${entry}"]

[policy]
version = 2
`);

    const body = await view();

    expect(body.sanitizers).toEqual([
      {
        kind: "sanitizer",
        name: "strip-customer-pii",
        source: { entry, battery: "support", line: 9 },
        implementation: { kind: "builtin", detail: "redact-email" },
        tags: ["support"],
        on: ["tool_output"],
        permits: { kind: "audience", from: ["internal"], to: ["public"] },
        lastConsult: null,
      },
    ]);
    expect(block(body, "audience")).toMatchObject({ cleaners: 1 });
  });

  test("the latest consult of a remedy shows only with organization-wide consult access", async ({
    makeUser,
    makeMember,
  }) => {
    await saveRoot(`[policy]
version = 2

[[policy.authority]]
name = "human"
permits = { attention = ["*"] }

[externals.authorities.human]
builtin = "hitl"
`);
    await seedConsult({
      organizationId: ctx.organizationId,
      role: "authority",
      externalName: "human",
      outcome: "answered",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedConsult({
      organizationId: ctx.organizationId,
      role: "authority",
      externalName: "human",
      outcome: "timeout",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    expect((await view()).authorities[0].lastConsult).toEqual({
      outcome: "timeout",
      at: "2026-01-02T00:00:00.000Z",
    });

    // An editor reads consult logs of their own sessions only.
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: EDITOR_ROLE_NAME,
    });
    expect((await view()).authorities[0].lastConsult).toBeNull();
  });
});

async function seedConsult(params: {
  organizationId: string;
  role: "authority" | "sanitizer";
  externalName: string;
  outcome: "answered" | "timeout";
  createdAt: Date;
}) {
  await db.insert(schema.openappaExternalConsultsTable).values({
    id: randomUUID(),
    organizationId: params.organizationId,
    createdAt: params.createdAt,
    startedAt: params.createdAt,
    durationMs: 1,
    role: params.role,
    externalName: params.externalName,
    backend: "hitl",
    request: {},
    outcome: params.outcome,
    root: "root",
    trajectory: "root",
  });
}
