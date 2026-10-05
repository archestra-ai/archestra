import { createHash, randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-trust-audience.routes";

const ARCHESTRA = "batteries/archestra/appa.toml";
const GITHUB = "batteries/github/appa.toml";

describe("GET /api/openappa/trust-audience", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
  });

  const view = async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/trust-audience",
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const audience = (body: { audiences: { name: string }[] }, name: string) =>
    body.audiences.find((level) => level.name === name);
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
  const batteryLine = async (entry: string, needle: string) => {
    const { content } = await openappaBatteriesService.policySource(
      ctx.organizationId,
      entry,
    );
    return content.split("\n").findIndex((line) => line.includes(needle)) + 1;
  };
  const rootLine = (content: string, line: string) =>
    content.split("\n").indexOf(line) + 1;

  test("is not found while Guardrails v2 is disabled", async () => {
    config.openappa.enabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/trust-audience",
    });
    expect(response.statusCode).toBe(404);
  });

  test("the default policy maps internal to the archestra battery's members", async () => {
    const body = await view();
    const root = (await guardrailsPolicyService.get(ctx.organizationId))
      .content;

    expect(body.trust).toEqual(["suspicious", "trusted"]);
    expect(body.audiences.map((level: { name: string }) => level.name)).toEqual(
      ["public", "internal", "self"],
    );
    expect(audience(body, "public")).toMatchObject({ kind: "builtin" });
    expect(audience(body, "internal")).toMatchObject({
      kind: "mapped",
      mappingLine: rootLine(root, 'internal = ["archestra:members"]'),
      within: null,
      from: [
        {
          source: "archestra",
          selector: "members",
          entry: ARCHESTRA,
          line: await batteryLine(ARCHESTRA, '{ template = "members"'),
        },
      ],
    });
    expect(audience(body, "self")).toEqual({ name: "self", kind: "builtin" });
    expect(body.sources).toEqual([
      {
        name: "archestra",
        battery: "archestra",
        entry: ARCHESTRA,
        line: await batteryLine(ARCHESTRA, "[externals.audience.archestra]"),
        runBy: "archestra",
        templates: [
          { template: "members", feeds: "internal" },
          { template: "team/<team>", feeds: null },
          { template: "user/<user>", feeds: null },
        ],
        usedBy: ["internal"],
        lastConsult: null,
      },
    ]);
  });

  test("an audience rules name but nothing maps is unmapped", async () => {
    const content = `[policy]
version = 2
trust_chain = ["untrusted", "reviewed", "trusted"]

[policy.audience]
internal = []

[[policy.tool]]
name = "mail__read"
delta = { audience = ["self"] }

[[policy.tool]]
name = "mail__send"
delta = { audience = ["self"] }
requires = { audience = { contains = ["self"], within = ["internal"] } }

[[policy.tool]]
name = "docs__search"
delta = { trust = "untrusted", audience = ["public"] }
`;
    await saveRoot(content);

    const body = await view();

    expect(body.trust).toEqual(["untrusted", "reviewed", "trusted"]);
    expect(audience(body, "self")).toEqual({ name: "self", kind: "unmapped" });
    expect(audience(body, "internal")).toMatchObject({
      kind: "mapped",
      from: [],
    });
    expect(audience(body, "public")).toEqual({
      name: "public",
      kind: "builtin",
    });
    expect(body.sources).toEqual([]);
  });

  test("an audience read from two sources lists both, and a group follows the chain", async () => {
    const content = `include = ["${ARCHESTRA}", "${GITHUB}"]

[policy]
version = 2

[policy.audience]
internal = ["archestra:members", "github:org/acme/members"]

[policy.audience.group.eng]
within = "internal"
from = ["github:org/acme/team/eng"]

[[policy.tool]]
name = "wiki__publish"
requires = { audience = { within = ["@eng"] } }
`;
    await saveRoot(content);

    const body = await view();

    expect(audience(body, "internal")).toMatchObject({
      kind: "mapped",
      mappingLine: 7,
      from: [
        {
          source: "archestra",
          selector: "members",
          entry: ARCHESTRA,
          line: await batteryLine(ARCHESTRA, '{ template = "members"'),
        },
        {
          source: "github",
          selector: "org/acme/members",
          entry: GITHUB,
          line: await batteryLine(GITHUB, '{ template = "org/<org>/members"'),
        },
      ],
    });
    expect(body.audiences.at(-1)).toEqual({
      name: "@eng",
      kind: "mapped",
      mappingLine: 9,
      within: "internal",
      from: [
        {
          source: "github",
          selector: "org/acme/team/eng",
          entry: GITHUB,
          line: await batteryLine(
            GITHUB,
            '{ template = "org/<org>/team/<team>"',
          ),
        },
      ],
    });
    const github = body.sources.find(
      (source: { name: string }) => source.name === "github",
    );
    expect(github).toMatchObject({
      battery: "github",
      entry: GITHUB,
      runBy: "helper",
      usedBy: ["internal", "@eng"],
    });
  });

  test("the latest consult of each source shows only with organization-wide consult access", async ({
    makeUser,
    makeMember,
  }) => {
    await seedConsult({
      organizationId: ctx.organizationId,
      externalName: "archestra",
      outcome: "answered",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedConsult({
      organizationId: ctx.organizationId,
      externalName: "archestra",
      outcome: "timeout",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    expect((await view()).sources[0].lastConsult).toEqual({
      outcome: "timeout",
      at: "2026-01-02T00:00:00.000Z",
    });

    // An editor reads consult logs of their own sessions only.
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: EDITOR_ROLE_NAME,
    });
    expect((await view()).sources[0].lastConsult).toBeNull();
  });
});

async function seedConsult(params: {
  organizationId: string;
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
    role: "audience_source",
    externalName: params.externalName,
    backend: "archestra",
    request: {},
    outcome: params.outcome,
    root: "root",
    trajectory: "root",
  });
}
