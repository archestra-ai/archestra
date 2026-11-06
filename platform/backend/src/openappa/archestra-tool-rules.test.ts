/**
 * Archestra's side of the Archestra tools' rules: the composed default policy
 * names every tool, the proxy's derived arguments reach the battery's rules,
 * and a preview is ruled as the app tool it runs. Calls are decided by the
 * runtime's replay, with the arguments the proxy evaluates them with. Four
 * files probe a call: followed by a probe needing public readers, followed by
 * one needing trusted data, after a suspicious read, and after a read only the
 * requester may see. No audience source answers here, so a call that needs
 * `internal` after that read stops on the unanswered `archestra` source.
 */
import {
  ADMIN_ROLE_NAME,
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import ToolModel from "@/models/tool";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";
import { policyArguments, previewAppToolTarget } from "./policy-arguments";
import { toolEntries } from "./policy-text";
import { approvalPromptCall } from "./review-display";

/** Tools no rule names, and why. */
const UNNAMED: ArchestraToolShortName[] = [
  // Released by the host, or ruled as the call they dispatch.
  "run_tool",
  "execute_remedy_plan",
  "get_remedy_plans",
  "list_peer_messages",
  "preview_app_tool",
  // Ruled as `mcp/appa/yell` under any server name.
  "yell",
  // Dispatched only by a rendered app, which no agent lists.
  "app_data_get",
  "app_data_set",
  "app_data_list",
  "app_data_delete",
  "llm_complete",
  // A server's own rules, until the archestra battery names them: the
  // default policy's catch-all annotator judges each call meanwhile.
  "get_guardrails_server_rules",
  "preview_guardrails_server_rules_change",
  "propose_guardrails_server_rules_change",
  "get_guardrails_server_rules_change_status",
];

const ORGANIZATION_GRANT = {
  subject: { type: "organization", id: "*" },
  actions: ["read"],
};
const TEAM_GRANT = { subject: { type: "team", id: "t1" }, actions: ["use"] };
const SECRET = { key: "TOKEN", type: "secret" };

describe("Archestra tools under the composed default policy", () => {
  test("a rule names every tool but the unnamed ones", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    const { content } = await setUp({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    const named = new Set(
      toolEntries(content).map(({ name }) => ruledShortName(name)),
    );

    expect(
      ARCHESTRA_TOOL_SHORT_NAMES.filter((name) => !named.has(name)).sort(),
    ).toEqual([...UNNAMED].sort());
  });

  test("a share and a credential transfer are ruled by what they send", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    const { organizationId } = await setUp({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    const cases: Array<[ArchestraToolShortName, Record<string, unknown>]> = [
      ["create_agent", { initialGrants: [ORGANIZATION_GRANT] }],
      ["create_agent", { initialGrants: [TEAM_GRANT, ORGANIZATION_GRANT] }],
      ["create_agent", { initialGrants: [TEAM_GRANT] }],
      ["create_agent", { initialGrants: [] }],
      ["create_agent", {}],
      ["create_agent", { initialGrants: "everyone" }],
      [
        "create_agent",
        { initialGrants: [{ subject: { type: "organization", id: "t1" } }] },
      ],
      // A grant the tool would refuse derives nothing it could pass with.
      [
        "create_agent",
        { initialGrants: [{ subject: ORGANIZATION_GRANT.subject }] },
      ],
      [
        "create_agent",
        {
          initialGrants: [
            { subject: { type: "serviceAccount", id: "sa" }, actions: ["use"] },
          ],
        },
      ],
      // A derived name the model sends is replaced by what the call shares.
      ["create_mcp_gateway", { initialGrantPrincipals: ["organization"] }],
      ["transfer_credential", { environment: [{ ...SECRET, value: "v" }] }],
      ["transfer_credential", { environment: [SECRET] }],
      ["transfer_credential", {}],
      ["transfer_credential", { transferModes: ["link"] }],
    ];

    expect(
      await contracts(
        organizationId,
        cases.map(([name, args]) => evaluated(name, args)),
      ),
    ).toEqual([
      "-/trusted+internal",
      "-/trusted+internal",
      "-/trusted+internal",
      "-/trusted",
      "-/trusted",
      "refused",
      "refused",
      "refused",
      "refused",
      "-/-",
      "-/trusted+internal",
      // A link declares the key to every reader of the target agent.
      "-/internal",
      "-/trusted+internal",
      "-/trusted+internal",
    ]);
  });

  test("an approval prompt shows the call without the derived arguments", () => {
    const shown = (
      shortName: ArchestraToolShortName,
      args: Record<string, unknown>,
    ) => {
      const call = evaluated(shortName, args);
      return approvalPromptCall({
        toolName: archestraMcpBranding.getToolName("execute_remedy_plan"),
        review: {
          text: "Approve this call?",
          tool: call.name,
          arguments: JSON.stringify(call.args),
        },
      }).toolArgs;
    };
    const share = {
      name: "a",
      initialGrants: [TEAM_GRANT, ORGANIZATION_GRANT],
    };
    const malformed = { name: "a", initialGrants: "everyone" };
    const transfer = { agent_id: "a", environment: [SECRET] };

    expect(evaluated("create_agent", share).args).toHaveProperty(
      "initialGrantPrincipals",
    );
    expect(shown("create_agent", share)).toEqual(share);
    expect(shown("create_agent", malformed)).toEqual(malformed);
    expect(shown("transfer_credential", transfer)).toEqual(transfer);
    // A tool that derives nothing keeps what the model sent under that name.
    expect(
      shown("get_agent", { id: "a", initialGrantPrincipals: ["x"] }),
    ).toEqual({ id: "a", initialGrantPrincipals: ["x"] });
    // Another server's tool keeps an argument that matches what Archestra
    // would derive, while the Archestra tool still hides its copy.
    const sent = { ...transfer, transferModes: ["link"] };
    expect(
      approvalPromptCall({
        toolName: archestraMcpBranding.getToolName("execute_remedy_plan"),
        review: {
          text: "Approve this call?",
          tool: "mcp/vault/transfer_credential",
          arguments: JSON.stringify(sent),
        },
      }).toolArgs,
    ).toEqual(sent);
    expect(evaluated("transfer_credential", transfer).args).toEqual(sent);
    expect(shown("transfer_credential", transfer)).toEqual(transfer);
  });

  test("a preview is ruled as the exact app tool it runs", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  }) => {
    const { organizationId } = await setUp({
      makeOrganization,
      makeAdmin,
      makeMember,
      root: `
[[policy.tool]]
name = "mcp/served/list_items"
delta = { trust = "suspicious" }
`,
    });
    const app = await makeApp({ organizationId });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "served__list_items",
      catalogId: catalog.id,
    });
    await makeAppTool(app.id, tool.id);
    const preview = (toolName: string) => ({
      toolCallName: archestraMcpBranding.getToolName("preview_app_tool"),
      toolCallArgs: JSON.stringify({ appId: app.id, toolName, args: {} }),
    });

    const target = await previewAppToolTarget(preview(tool.name));
    expect(target).toEqual({
      toolCallName: tool.name,
      toolCallArgs: "{}",
      isRunToolDispatchTarget: true,
    });
    if ("refusal" in target) return;
    expect(
      await contracts(organizationId, [
        { name: "mcp/served/list_items", args: {} },
        evaluatedAs(target.toolCallName, {}),
        evaluated("preview_app_tool", { appId: app.id, toolName: tool.name }),
      ]),
    ).toEqual(["suspicious/-", "suspicious/-", "catch-all"]);
    // A suffix could resolve to another assigned tool by the time it runs.
    expect(await previewAppToolTarget(preview("list_items"))).toEqual({
      refusal: `Call preview_app_tool with the tool's full name, "${tool.name}".`,
    });
    expect(
      await previewAppToolTarget(preview("served__delete_items")),
    ).toHaveProperty("refusal");
    expect(
      await previewAppToolTarget({
        ...preview(tool.name),
        toolCallArgs: JSON.stringify({ appId: "a", toolName: tool.name }),
      }),
    ).toEqual({ refusal: 'App "a" not found.' });
  });

  test("the host's own tools are ruled under the white-labeled server name", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    config.enterpriseFeatures.fullWhiteLabeling = true;
    const { organizationId } = await setUp({
      makeOrganization,
      makeAdmin,
      makeMember,
      branding: { appName: "Acme Labs", iconLogo: null },
    });
    expect(archestraMcpBranding.serverName).not.toBe("archestra");

    expect(
      await contracts(organizationId, [
        evaluated("read_peer_message", { message_id: "m" }),
        { name: "mcp/appa/yell", args: {} },
        evaluated("get_agent", {}),
      ]),
    ).toEqual(["-/-", "-/-", "narrows/-"]);
  });
});

// ===

type Fixtures = {
  makeOrganization: () => Promise<{ id: string }>;
  makeAdmin: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides?: { role?: string },
  ) => Promise<unknown>;
};

/** A call in scenario form: its canonical name and the arguments it is ruled with. */
type Call = { name: string; args: unknown };

const PROBES = `
[[policy.tool]]
name = "host/archestra/probe_read_web"
delta = { trust = "suspicious" }

[[policy.tool]]
name = "host/archestra/probe_read_self"
delta = { audience = ["self"] }

[[policy.tool]]
name = "host/archestra/probe_publish"
delta = {}
requires = { audience = { contains = ["public"] } }

[[policy.tool]]
name = "host/archestra/probe_act"
delta = {}
requires = { trust = "trusted" }
`;

async function setUp(
  params: Fixtures & {
    root?: string;
    branding?: { appName: string; iconLogo: null };
  },
) {
  config.openappa.enabled = true;
  const organizationId = (await params.makeOrganization()).id;
  const admin = await params.makeAdmin();
  await params.makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
  await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID, params.branding);
  const latest = await guardrailsPolicyService.get(organizationId);
  await guardrailsPolicyService.update({
    organizationId,
    userId: admin.id,
    expectedRevision: latest.revision,
    content: `${initialPolicy()}${PROBES}${params.root ?? ""}`,
  });
  const composed = await openappaBatteriesService.recompile(organizationId);
  expect(composed.lastError).toBeNull();
  return { organizationId, content: composed.content ?? "" };
}

/** The Archestra tool a rule names, spelled canonically or as called, selectors aside. */
function ruledShortName(ruleName: string): ArchestraToolShortName | null {
  const name = ruleName.replace(/\(.*$/, "");
  const canonical = /^mcp\/([^/]+)\/([^/]+)$/.exec(name);
  return archestraMcpBranding.getToolShortName(
    canonical ? `${canonical[1]}__${canonical[2]}` : name,
  );
}

function evaluated(
  shortName: ArchestraToolShortName,
  args: Record<string, unknown>,
): Call {
  return evaluatedAs(archestraMcpBranding.getToolName(shortName), args);
}

/** A gateway call as the proxy evaluates it. */
function evaluatedAs(toolName: string, args: Record<string, unknown>): Call {
  const separator = toolName.lastIndexOf("__");
  return {
    name: `mcp/${toolName.slice(0, separator)}/${toolName.slice(separator + 2)}`,
    args: policyArguments(toolName, args),
  };
}

function step(name: string, args: unknown = {}): string {
  const lines = Object.entries(args as Record<string, unknown>).map(
    ([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`,
  );
  return `${name} {\n${lines.join("")}}\nexpect allow\n`;
}

type Step = { status: string; actual: string | null; error?: string };

/** Each call's contract, `<adds>/<needs>`, or what decided the call alone instead. */
async function contracts(
  organizationId: string,
  calls: Call[],
): Promise<string[]> {
  const policy = (
    await openappaBatteriesService.getEffectivePolicy(organizationId)
  ).content;
  const files = calls.flatMap(({ name, args }) => {
    const call = step(name, args);
    return [
      `${call}${step("host/archestra/probe_publish")}`,
      `${call}${step("host/archestra/probe_act")}`,
      `${step("host/archestra/probe_read_web")}${call}`,
      `${step("host/archestra/probe_read_self")}${call}`,
    ];
  });
  const steps: Step[][] = [];
  const native = await import("@archestra/openappa-rs");
  for (let start = 0; start < files.length; start += REPLAY_FILES) {
    const response = JSON.parse(
      await native.replayOpenappaPolicy(
        JSON.stringify({
          content: policy,
          files: files
            .slice(start, start + REPLAY_FILES)
            .map((file, index) => ({
              path: `${String(start + index).padStart(4, "0")}.appa`,
              content: file,
            })),
        }),
      ),
    ) as { files: { path: string; steps: Step[] }[] };
    for (const file of response.files)
      steps[Number.parseInt(file.path, 10)] = file.steps;
  }
  return calls.map((_, index) => {
    const [alone, publish] = steps[4 * index];
    if (alone.actual !== "allow") return decidedBy(alone);
    const allowed = (offset: number) =>
      steps[4 * index + offset][1]?.actual === "allow";
    const adds = [
      ...(publish?.actual === "allow" ? [] : ["narrows"]),
      ...(allowed(1) ? [] : ["suspicious"]),
    ];
    const needs = [
      ...(allowed(2) ? [] : ["trusted"]),
      ...(allowed(3) ? [] : [needsAfterSelf(steps[4 * index + 3][1])]),
    ];
    return `${adds.join("+") || "-"}/${needs.join("+") || "-"}`;
  });
}

function decidedBy(alone: Step): string {
  if (alone.actual === "deny") return "refused";
  const annotator = /annotator=(\S+) error=/.exec(alone.error ?? "")?.[1];
  if (annotator === "archestra.llm-annotator") return "catch-all";
  return annotator ? `annotator ${annotator}` : `${alone.actual}`;
}

/** What a call refused after a requester-only read needs: `internal` asks its source. */
function needsAfterSelf(after: Step | undefined): string {
  return after?.status === "cannot_run" &&
    /audience source "archestra" gave no answer/.test(after.error ?? "")
    ? "internal"
    : "public";
}

/** The replay engine's limit on files per run. */
const REPLAY_FILES = 32;
