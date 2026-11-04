/**
 * What each Archestra tool adds to a session and requires of it under the
 * default policy, composed with the bundled batteries and the host's own
 * rules, decided by the runtime's replay. Each call is ruled with the
 * arguments the proxy evaluates it with. Four files probe a call: followed by
 * a probe needing public readers, followed by one needing trusted data, after
 * a suspicious read, and after a read only the requester may see. No audience
 * source answers here, so a call that needs `internal` after that read stops
 * on the unanswered `archestra` source.
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
import { withHostToolRules } from "./host-tool-rules";
import { policyArguments, previewAppToolTarget } from "./policy-arguments";

/** `<adds>/<needs>`: `narrows` the readers or adds `suspicious`; needs `trusted` or `internal`. */
const CONTRACTS: Record<string, ArchestraToolShortName[]> = {
  "-/-": [
    "whoami",
    "resolve_openappa_yell",
    "validate_guardrails_policy",
    "request_runtime_credential_setup",
    "request_battery_credentials",
    "create_mcp_gateway",
    "reload_mcp_server_tools",
    "update_knowledge_connector",
    "todo_write",
    "ask_user",
    "create_project_from_conversation",
    "link_app_to_project",
    "unlink_app_from_project",
    "search_tools",
    "load_skill",
    "cancel_agent_run",
    "upload_file",
    "search_files",
    "scaffold_app",
    "set_app_labels",
    "validate_app",
  ],
  "narrows/-": [
    "get_guardrails_policy",
    "get_openappa_policy_tests",
    "run_openappa_policy_tests",
    "preview_guardrails_validation_change",
    "get_openappa_yell",
    "list_openappa_yells",
    "list_openappa_consults",
    "list_guardrails_battery_fits",
    "inspect_guardrails_server",
    "preview_guardrails_policy_change",
    "get_guardrails_policy_change_status",
    "list_runtime_credentials",
    "get_runtime_credential",
    "get_agent",
    "list_agents",
    "list_llm_models",
    "get_agent_skill_policy",
    "list_hooks",
    "get_mcp_gateway",
    "search_private_mcp_registry",
    "get_mcp_servers",
    "get_mcp_server_tools",
    "list_mcp_server_deployments",
    "get_mcp_server_logs",
    "get_team",
    "list_teams",
    "list_team_members",
    "list_team_external_groups",
    "get_limits",
    "get_agent_token_usage",
    "get_llm_proxy_token_usage",
    "get_knowledge_bases",
    "get_knowledge_base",
    "get_knowledge_connectors",
    "get_knowledge_connector",
    "list_projects",
    "get_project",
    "list_schedule_triggers",
    "get_schedule_trigger",
    "list_schedule_trigger_runs",
    "get_schedule_trigger_run",
    "list_skills",
    "list_plugins",
    "get_plugin",
    "get_agent_run",
    "list_agent_runs",
    "read_workspace_file",
    "read_file",
    "read_file_raw",
    "list_apps",
    "list_app_versions",
    "render_app",
    "read_app",
    "get_app_diagnostics",
  ],
  "narrows+suspicious/-": [
    "query_knowledge_sources",
    "get_schedule_trigger_run_transcript",
  ],
  "-/trusted": [
    "update_guardrails_validation",
    "update_guardrails_policy",
    "bind_guardrails_credential",
    "create_runtime_credential",
    "update_runtime_credential",
    "delete_runtime_credential",
    "create_guardrails_repository",
    "connect_guardrails_repository",
    "sync_guardrails_repository",
    "create_agent",
    "patch_agent_skill_policy",
    "delete_hook",
    "edit_mcp_description",
    "edit_mcp_config",
    "create_mcp_server",
    "deploy_mcp_server",
    "create_team",
    "edit_team",
    "delete_team",
    "update_team_member_role",
    "remove_team_member",
    "remove_team_external_group",
    "create_limit",
    "update_limit",
    "delete_limit",
    "bulk_assign_tools_to_agents",
    "bulk_remove_tools_from_agents",
    "bulk_assign_tools_to_mcp_gateways",
    "create_knowledge_base",
    "delete_knowledge_base",
    "delete_knowledge_connector",
    "assign_knowledge_connector_to_knowledge_base",
    "unassign_knowledge_connector_from_knowledge_base",
    "assign_knowledge_base_to_agent",
    "unassign_knowledge_base_from_agent",
    "assign_knowledge_connector_to_agent",
    "unassign_knowledge_connector_from_agent",
    "delete_schedule_trigger",
    "enable_schedule_trigger",
    "disable_schedule_trigger",
    "run_schedule_trigger_now",
    "create_plugin",
    "delete_plugin",
    "delete_workspace",
    "delete_file",
    "set_app_lock",
    "delete_app",
  ],
  "-/trusted+internal": [
    "edit_agent",
    "create_hook",
    "update_hook",
    "edit_mcp_gateway",
    "add_team_external_group",
    "update_knowledge_base",
    "create_knowledge_connector",
    "create_schedule_trigger",
    "update_schedule_trigger",
    "create_skill",
    "update_skill",
    "edit_skill",
    "update_plugin",
    "edit_plugin",
    "post_agent_run_file",
    "post_agent_run_message",
    "transfer_credential",
    "download_file",
    "save_file",
    "edit_file",
    "copy_file",
    "refine_app",
    "restore_app_version",
    "edit_app",
    "set_app_tools",
    "publish_app",
  ],
  "-/internal": ["start_agent_run", "steer_agent_run", "write_workspace_file"],
  "narrows/internal": ["transfer_workspace_file"],
  // The battery declares the tool's arguments; a call without them is refused.
  refused: ["add_team_member"],
  // The default root labels each sandbox command with the annotator model.
  "annotator archestra.run-command": ["run_command"],
  // Dispatched only by a rendered app, which no agent lists.
  "catch-all": [
    "app_data_get",
    "app_data_set",
    "app_data_list",
    "app_data_delete",
    "llm_complete",
  ],
};

/** Ruled by the host, not the battery. */
const HOST_RULED: ArchestraToolShortName[] = [
  "run_tool",
  "execute_remedy_plan",
  "get_remedy_plans",
  "list_peer_messages",
  "read_peer_message",
  "yell",
  "preview_app_tool",
];

/** Arguments a tool's unselected rule needs, where `{}` selects no rule. */
const ARGUMENTS: Partial<
  Record<ArchestraToolShortName, Record<string, unknown>>
> = {
  publish_app: { appId: "a", scope: "org" },
};

const ORGANIZATION_GRANT = {
  subject: { type: "organization", id: "*" },
  actions: ["read"],
};
const TEAM_GRANT = { subject: { type: "team", id: "t1" }, actions: ["use"] };
const SECRET = { key: "TOKEN", type: "secret" };

describe("Archestra tools under the composed default policy", () => {
  test("every tool has its contract, or the host rules it", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    const { organizationId } = await setUp({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    const tabled = Object.values(CONTRACTS).flat();
    expect(
      ARCHESTRA_TOOL_SHORT_NAMES.filter(
        (name) => !tabled.includes(name) && !HOST_RULED.includes(name),
      ),
    ).toEqual([]);

    const actual = await contracts(
      organizationId,
      tabled.map((name) => evaluated(name, ARGUMENTS[name] ?? {})),
    );

    expect(
      Object.fromEntries(tabled.map((name, index) => [name, actual[index]])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(CONTRACTS).flatMap(([contract, names]) =>
          names.map((name) => [name, contract]),
        ),
      ),
    );
  }, 180_000);

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
      ["create_agent", { initialGrants: [] }],
      ["create_agent", { initialGrants: "everyone" }],
      [
        "create_agent",
        { initialGrants: [{ subject: { type: "organization", id: "t1" } }] },
      ],
      ["create_mcp_gateway", { initialGrants: [ORGANIZATION_GRANT] }],
      // A derived name the model sends is replaced by what the call shares.
      ["create_mcp_gateway", { initialGrantPrincipals: ["organization"] }],
      ["scaffold_app", { initialGrants: [TEAM_GRANT] }],
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
      "-/trusted",
      "refused",
      "refused",
      "-/trusted+internal",
      "-/-",
      "-/trusted+internal",
      "-/trusted+internal",
      "-/-",
      "-/trusted+internal",
      "-/trusted+internal",
    ]);
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
  });

  test("with Git sync, a policy change needs the repository's readers over the organization's own rule", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    const { organizationId, content } = await setUp({
      makeOrganization,
      makeAdmin,
      makeMember,
      root: `
[[policy.tool]]
name = "mcp/archestra/update_guardrails_policy"
delta = {}
`,
    });
    const native = await import("@archestra/openappa-rs");
    const synced = (gitSyncAudience: "internal" | "public") =>
      withHostToolRules({
        composed: content,
        host: { serverName: archestraMcpBranding.serverName, gitSyncAudience },
        validate: (text) => native.validateHostedOpenappaPolicy(text),
      });
    const calls = [
      evaluated("update_guardrails_policy", {}),
      evaluated("update_guardrails_validation", {}),
    ];

    expect(await contracts(organizationId, calls, content)).toEqual([
      "-/-",
      "-/trusted",
    ]);
    expect(
      await contracts(organizationId, calls, await synced("internal")),
    ).toEqual(["-/trusted+internal", "-/trusted+internal"]);
    expect(
      await contracts(organizationId, calls, await synced("public")),
    ).toEqual(["-/trusted+public", "-/trusted+public"]);
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
  return { organizationId, content: composed.content };
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

/** Each call's contract, or what decided the call alone instead. */
async function contracts(
  organizationId: string,
  calls: Call[],
  content?: string,
): Promise<string[]> {
  const policy =
    content ??
    (await openappaBatteriesService.getEffectivePolicy(organizationId)).content;
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
