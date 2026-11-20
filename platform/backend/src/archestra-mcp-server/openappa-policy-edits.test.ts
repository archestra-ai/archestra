import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import config from "@/config";
import A2aRemoteAgentModel, {
  A2aConnectionModel,
} from "@/models/a2a-remote-agent";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import ToolModel from "@/models/tool";
import ToolObservationModel from "@/models/tool-observation";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const ANCHOR = '[[policy.tool]]\nname = "*"\n';

function rules(names: string[]): string {
  return names
    .map((name) => `[[policy.tool]]\nname = "${name}"\ndelta = {}\n\n`)
    .join("");
}

function withRules(names: string[]): string {
  return initialPolicy().replace(ANCHOR, `${rules(names)}${ANCHOR}`);
}

const NEW_RULES = rules(["github__create_issue", "github__add_comment"]);
const INSERT = [{ oldText: ANCHOR, newText: `${NEW_RULES}${ANCHOR}` }];

let context: ArchestraContext;
let organizationId: string;
let userId: string;
let policyEditorRole: string;

beforeEach(
  async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    config.openappa.enabled = true;
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    await seedAndAssignArchestraTools(agent.id);
    organizationId = org.id;
    userId = user.id;
    const editor = await makeCustomRole(org.id, {
      permission: { guardrailsPolicy: ["read", "update"] },
    });
    policyEditorRole = editor.role;
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
      userId,
    };
  },
);

async function saveRevision(content: string) {
  const { revision } = await guardrailsPolicyService.get(organizationId);
  return guardrailsPolicyService.update({
    organizationId,
    userId,
    content,
    expectedRevision: revision,
  });
}

function preview(args: Record<string, unknown>) {
  return executeArchestraTool(
    "archestra__preview_guardrails_policy_change",
    args,
    context,
  );
}

function publish(args: Record<string, unknown>) {
  return executeArchestraTool(
    "archestra__update_guardrails_policy",
    { title: "Add GitHub rules", summary: "Two write rules", ...args },
    context,
  );
}

/** What the chat model reads: the text block, not structuredContent. */
function modelText(
  result: CallToolResult,
): Record<string, unknown> & { diff: string } {
  expect(result.isError).toBeFalsy();
  const [block] = result.content;
  if (block?.type !== "text") throw new Error("Expected a text block");
  return JSON.parse(block.text);
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
}

describe("policy edits", () => {
  test("preview applies only the insertion and gives the model a diff instead of both texts; publish saves the same text", async () => {
    const current = withRules(["github__get_issue", "github__list_issues"]);
    await saveRevision(current);

    const previewed = await preview({
      edits: INSERT,
      expectedRevision: 1,
      allowUnknownTools: true,
    });
    const after = (previewed.structuredContent as { after: string }).after;
    expect(after).toBe(current.replace(ANCHOR, `${NEW_RULES}${ANCHOR}`));
    expect((previewed.structuredContent as { before: string }).before).toBe(
      current,
    );

    const seen = modelText(previewed);
    expect(seen).not.toHaveProperty("before");
    expect(seen).not.toHaveProperty("after");
    expect(seen).toMatchObject({
      stage: "preview",
      valid: true,
      changed: { added: 8, removed: 0 },
    });
    expect(seen.diff).toContain("+++ b/organization.appa.toml\n");
    expect(seen.diff).toContain('+name = "github__create_issue"\n');
    expect(seen.diff).toContain('+name = "github__add_comment"\n');
    expect(seen.diff.match(/^@@/gm)).toHaveLength(1);
    expect(seen.diff).not.toContain("github__get_issue");

    const published = await publish({ edits: INSERT, expectedRevision: 1 });
    const saved = await GuardrailsPolicyModel.findLatest(organizationId);
    expect(saved).toMatchObject({ revision: 2, content: after });
    const publishedText = modelText(published);
    expect(publishedText).not.toHaveProperty("after");
    expect(publishedText).toMatchObject({
      delivery: "revision",
      revision: 2,
      diff: seen.diff,
      changed: { added: 8, removed: 0 },
    });
    expect((published.structuredContent as { after: string }).after).toBe(
      after,
    );
  });

  test("a two-rule preview of a 1,000-rule policy stays small for the model", async () => {
    const current = withRules(
      Array.from({ length: 1000 }, (_, i) => `github__tool_${i}`),
    );
    await saveRevision(current);
    expect(current.length).toBeGreaterThan(50_000);

    const previewed = await preview({
      edits: INSERT,
      expectedRevision: 1,
      allowUnknownTools: true,
    });
    const [block] = previewed.content;
    expect(block?.type === "text" && block.text.length).toBeLessThan(2_000);
  });

  test("a stale revision is a conflict even when its edits no longer match", async () => {
    await saveRevision(withRules(["github__get_issue"]));
    const edits = [{ oldText: "not in the policy", newText: "x" }];
    for (const call of [preview, publish])
      expect(errorText(await call({ edits, expectedRevision: 0 }))).toContain(
        "The policy changed. Read it again",
      );
    expect(
      (await GuardrailsPolicyModel.findLatest(organizationId))?.revision,
    ).toBe(1);
  });

  test("refused edits explain the fix and save nothing", async () => {
    await saveRevision(withRules(["github__get_issue", "github__list_issues"]));
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { edits: [{ oldText: "github__missing", newText: "x" }] },
        "edits[0]: oldText was not found in the policy at revision 1. Copy the exact text from get_guardrails_policy, including whitespace.",
      ],
      [
        { edits: [{ oldText: "delta = {}", newText: "delta = { }" }] },
        "edits[0]: oldText matches 22 places. Add surrounding lines to make it unique, or set replaceAll to true.",
      ],
      [
        { edits: [{ oldText: "version = 2", newText: "version = 2" }] },
        "edits[0]: oldText and newText are the same. Remove this edit or change newText.",
      ],
      [
        { content: initialPolicy(), edits: INSERT },
        "Send either edits or content, not both.",
      ],
      [
        {},
        "Send edits to change the current policy, or content with the complete policy text.",
      ],
    ];
    for (const [args, message] of cases)
      for (const call of [preview, publish])
        expect(
          errorText(await call({ ...args, expectedRevision: 1 })),
        ).toContain(message);
    expect(
      (await GuardrailsPolicyModel.findLatest(organizationId))?.revision,
    ).toBe(1);
  });

  test("replaceAll changes every match", async () => {
    const current = withRules(["github__get_issue", "github__list_issues"]);
    await saveRevision(current);
    const previewed = await preview({
      edits: [
        {
          oldText: 'name = "github__',
          newText: 'name = "gh__',
          replaceAll: true,
        },
      ],
      expectedRevision: 1,
      allowUnknownTools: true,
    });
    expect(modelText(previewed).changed).toEqual({ added: 2, removed: 2 });
    expect((previewed.structuredContent as { after: string }).after).toBe(
      current.replaceAll('name = "github__', 'name = "gh__'),
    );
  });

  test("strict-mode filler for the unused field is accepted", async () => {
    const current = withRules(["github__get_issue"]);
    await saveRevision(current);
    const edited = current.replace(ANCHOR, `${NEW_RULES}${ANCHOR}`);
    const fillers: Array<Record<string, unknown>> = [
      { content: "", edits: INSERT, allowUnknownTools: true },
      {
        content: null,
        edits: [{ ...INSERT[0], replaceAll: null }],
        allowUnknownTools: true,
      },
      { content: edited, edits: [], allowUnknownTools: true },
      { content: edited, edits: null, allowUnknownTools: true },
    ];
    for (const args of fillers) {
      const previewed = await preview({ ...args, expectedRevision: 1 });
      expect(modelText(previewed).changed).toEqual({ added: 8, removed: 0 });
      expect((previewed.structuredContent as { after: string }).after).toBe(
        edited,
      );
    }
  });

  test("a preview that proposes a change tells the model to ask for approval; one that proposes nothing does not", async () => {
    const policy = withRules(["github__list_issues"]);
    const { revision } = await saveRevision(policy);

    const change = modelText(
      await preview({
        edits: INSERT,
        expectedRevision: revision,
        allowUnknownTools: true,
      }),
    );
    const noChange = modelText(
      await preview({ content: policy, expectedRevision: revision }),
    );

    expect(change.instruction).toContain("ask_user");
    expect(noChange).not.toHaveProperty("instruction");
  });

  test("content still replaces the whole policy and returns a diff", async () => {
    const content = withRules(["github__get_issue"]);
    const previewed = await preview({
      content,
      expectedRevision: 0,
      allowUnknownTools: true,
    });
    const seen = modelText(previewed);
    expect(seen).not.toHaveProperty("after");
    expect(seen.changed).toEqual({ added: 4, removed: 0 });
    expect(seen.diff).toContain('+name = "github__get_issue"\n');

    await publish({ content, expectedRevision: 0 });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ revision: 1, content });
  });
});

describe("rules naming tools", () => {
  for (const caller of ["observed member", "unobserving admin"]) {
    test(`a proxy tool is known to an ${caller} at preview and publish`, async ({
      makeUser,
      makeMember,
    }) => {
      const observer = await makeUser();
      await makeMember(observer.id, organizationId, {
        role: `member,${policyEditorRole}`,
      });
      expect(
        await hasAnyAgentTypeAdminPermission({
          userId: observer.id,
          organizationId,
        }),
      ).toBe(false);
      const name = "workbench__read_document";
      await ToolModel.bulkCreateProxyToolsIfNotExists(
        [
          {
            name,
            description: "Read a document from the workspace.",
            parameters: {
              type: "object",
              properties: { path: {}, revision: {} },
            },
          },
        ],
        context.agent?.id ?? "",
      );
      await ToolObservationModel.recordObservations({
        toolNames: [name],
        userId: observer.id,
      });
      const { revision } = await saveRevision(initialPolicy());
      if (caller === "observed member") context.userId = observer.id;
      const content = withRules([name]);
      const previewed = modelText(
        await preview({ content, expectedRevision: revision }),
      );
      expect(previewed).toMatchObject({ valid: true, warnings: [] });
      expect(previewed.touchedTools).toMatchObject({
        tools: [
          {
            name,
            description: "Read a document from the workspace.",
            arguments: ["path", "revision"],
          },
        ],
        omitted: 0,
      });
      expect(
        modelText(await publish({ content, expectedRevision: revision })),
      ).toMatchObject({ warnings: [] });
    });
  }

  test("a member cannot discover another user's proxy tools through targets, metadata or suggestions", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, {
      role: `member,${policyEditorRole}`,
    });
    expect(
      await hasAnyAgentTypeAdminPermission({
        userId: member.id,
        organizationId,
      }),
    ).toBe(false);
    const name = "workbench__read_document";
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [
        {
          name,
          description: "Private tool metadata.",
          parameters: { type: "object", properties: { privatePath: {} } },
        },
      ],
      context.agent?.id ?? "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: [name],
      userId,
    });
    const { revision } = await saveRevision(initialPolicy());
    context.userId = member.id;
    for (const ruleName of [
      name,
      "workbench__read_documen",
      "workbenc__read_document",
    ]) {
      const targets = await guardrailsPolicyService.touchedRuleTargets({
        organizationId,
        userId: member.id,
        content: withRules([ruleName]),
        previous: initialPolicy(),
      });
      expect(targets).toEqual([
        {
          kind: "unknown_server",
          rule: ruleName,
          server: ruleName.split("__")[0],
          closest: [],
        },
      ]);
      const gated = await preview({
        content: withRules([ruleName]),
        expectedRevision: revision,
      });
      const seen = modelText(gated);
      expect(seen).toMatchObject({
        stage: "confirmation_required",
        valid: true,
        unknownTools: [
          {
            rule: ruleName,
            reason: "unknown_server",
            prefix: ruleName.split("__")[0],
            closest: [],
          },
        ],
      });
      expect(gated.structuredContent).not.toHaveProperty("before");
      expect(gated.structuredContent).not.toHaveProperty("delivery");

      const confirmed = modelText(
        await preview({
          content: withRules([ruleName]),
          expectedRevision: revision,
          allowUnknownTools: true,
        }),
      );
      expect(confirmed).toMatchObject({
        stage: "preview",
        valid: true,
        warnings: [],
        touchedTools: null,
      });
    }
    const published = modelText(
      await publish({ content: withRules([name]), expectedRevision: revision }),
    );
    expect(published.warnings).toHaveLength(1);
    expect(JSON.stringify(published.warnings)).not.toContain("did you mean");
  });

  test("outbound A2A tools are excluded even for an admin who observed them", async () => {
    const remote = await A2aRemoteAgentModel.create({
      data: {
        organizationId,
        authorId: userId,
        name: "Document assistant",
        scope: "org",
        discoveryMode: "inline_card",
        agentCard: { name: "Document assistant" },
        cardHash: "test-card-hash",
      },
    });
    const connection = await A2aConnectionModel.create({
      remoteAgentId: remote.id,
      authType: "none",
      selectedInterface: {
        url: "https://agent.example.test/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    });
    const name = "remote__read_document";
    await ToolModel.create({
      name,
      parameters: {},
      delegateToA2aConnectionId: connection.id,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [name],
      userId,
    });
    const { revision } = await saveRevision(initialPolicy());
    const content = withRules([name]);
    const gated = modelText(
      await preview({ content, expectedRevision: revision }),
    );
    expect(gated).toMatchObject({
      stage: "confirmation_required",
      valid: true,
      unknownTools: [
        {
          rule: name,
          reason: "unknown_server",
          prefix: "remote",
          closest: [],
        },
      ],
    });
    const confirmed = modelText(
      await preview({
        content,
        expectedRevision: revision,
        allowUnknownTools: true,
      }),
    );
    expect(confirmed).toMatchObject({
      stage: "preview",
      valid: true,
      warnings: [],
      touchedTools: null,
    });
    expect(
      modelText(await publish({ content, expectedRevision: revision }))
        .warnings,
    ).toHaveLength(1);
  });

  test("catalog metadata takes precedence over proxy metadata for the same name", async ({
    makeInternalMcpCatalog,
  }) => {
    const name = "workbench__read_document";
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [
        {
          name,
          description: "Client description.",
          parameters: { type: "object", properties: { clientPath: {} } },
        },
      ],
      context.agent?.id ?? "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: [name],
      userId,
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Workbench",
    });
    await ToolModel.create({
      catalogId: catalog.id,
      name,
      description: "Server description.",
      parameters: { type: "object", properties: { path: {} } },
    });
    const { revision } = await saveRevision(initialPolicy());
    const previewed = modelText(
      await preview({ content: withRules([name]), expectedRevision: revision }),
    );
    expect(previewed).toMatchObject({
      stage: "preview",
      warnings: [],
      touchedTools: {
        tools: [
          { name, description: "Server description.", arguments: ["path"] },
        ],
      },
    });
  });

  test("provisional and agent-owned tools do not enter the proxy inventory", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const names = [
      "workbench__provisional",
      "workbench__owned",
      "workbench__delegated",
    ];
    await ToolModel.create({
      name: names[0],
      parameters: {},
      clonedPendingDiscovery: true,
    });
    await ToolModel.create({
      name: names[1],
      parameters: {},
      agentId: agent.id,
    });
    await ToolModel.create({
      name: names[2],
      parameters: {},
      delegateToAgentId: agent.id,
    });
    await ToolObservationModel.recordObservations({ toolNames: names, userId });
    const { revision } = await saveRevision(initialPolicy());
    const gated = modelText(
      await preview({ content: withRules(names), expectedRevision: revision }),
    );
    expect(gated).toMatchObject({
      stage: "confirmation_required",
      valid: true,
      unknownTools: names.map((rule) => ({
        rule,
        reason: "unknown_server",
        prefix: "workbench",
        closest: [],
      })),
    });
  });

  test("an unknown tool requires user confirmation before previewing; after confirmation, preview proceeds cleanly without missing-tool warnings", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const github = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub",
    });
    await makeTool({
      catalogId: github.id,
      name: "github__create_issue",
      description: "Create an issue in a repository.",
      parameters: { type: "object", properties: { repo: {}, title: {} } },
    });
    const { revision } = await saveRevision(initialPolicy());
    const edits = (names: string[]) => [
      { oldText: ANCHOR, newText: `${rules(names)}${ANCHOR}` },
    ];

    const known = modelText(
      await preview({
        edits: edits(["github__create_issue"]),
        expectedRevision: revision,
      }),
    );
    const missingRaw = await preview({
      edits: edits(["github__delete_issue"]),
      expectedRevision: revision,
      allowUnknownTools: null,
    });
    const missing = modelText(missingRaw);

    expect(known).toMatchObject({
      stage: "preview",
      valid: true,
      warnings: [],
    });
    expect(known.touchedTools).toMatchObject({
      tools: [
        {
          name: "github__create_issue",
          description: "Create an issue in a repository.",
          arguments: ["repo", "title"],
        },
      ],
      omitted: 0,
    });

    expect(missing).toMatchObject({
      stage: "confirmation_required",
      valid: true,
      warnings: [],
      unknownTools: [
        {
          rule: "github__delete_issue",
          reason: "unknown_tool",
          prefix: "github",
          closest: ["github__create_issue"],
        },
      ],
    });
    expect(missingRaw.structuredContent).not.toHaveProperty("before");
    expect(missingRaw.structuredContent).not.toHaveProperty("after");
    expect(missingRaw.structuredContent).not.toHaveProperty("delivery");
    expect(missing.instruction).toContain("ask_user");
    expect(missing.instruction).toContain("allowUnknownTools");

    const confirmed = modelText(
      await preview({
        edits: edits(["github__delete_issue"]),
        expectedRevision: revision,
        allowUnknownTools: true,
      }),
    );
    expect(confirmed).toMatchObject({
      stage: "preview",
      valid: true,
      warnings: [],
      touchedTools: null,
      changed: { added: 4, removed: 0 },
    });
    expect(confirmed.diff).toContain('+name = "github__delete_issue"\n');
    expect(confirmed.instruction).toBe(known.instruction);

    const published = modelText(
      await publish({
        edits: edits(["github__delete_issue"]),
        expectedRevision: revision,
      }),
    );
    expect(published.warnings).toHaveLength(1);
  });
});
