import { createHash } from "node:crypto";
import { vi } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import config from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import * as appaService from "@/openappa/service";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import { resolveGatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT, type AppaTrustedContext } from "./types";

/**
 * A client's own MCP server the policy names: its calls reach evaluation
 * under the alias target's name, the way a gateway server's calls reach it
 * under the catalog's, so battery rules and a hand-written rule bound through
 * `[server_aliases]` rule both. The runtime maps `<target>__<tool>` to
 * `mcp/<target>/<tool>` and expands a `server = "x"` rule to every target
 * under `x`; what this proves is the name the plugin hands it.
 */
describe("ruling a client's own MCP server under its alias target", () => {
  setupTestCacheManager();

  const POLICY = `include = []

[server_aliases]
myslack = ["slack", "claude-code.slack", "codex.slack", "opencode.slack"]

[policy]
version = 2

[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "send"
server = "myslack"
delta = {}

[[policy.tool]]
name = "*"
annotator = "noop"

[externals.annotators.noop]
url = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"
`;

  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await GuardrailsPolicyModel.save({
      organizationId,
      content: POLICY,
      contentHash: createHash("sha256").update(POLICY).digest("hex"),
      updatedBy: user.id,
      expectedRevision: 0,
    });
  });

  const clients: Array<{
    client: string;
    adapter: () =>
      | AppaClaudeCodeAdapter
      | AppaCodexAdapter
      | AppaOpenCodeAdapter;
    headers: Record<string, string>;
    declared: Array<{ name: string; namespace?: string }>;
    calls: Record<string, string>;
    namespace?: string;
  }> = [
    {
      client: "Claude Code",
      adapter: () => new AppaClaudeCodeAdapter(),
      headers: { "user-agent": "claude-cli/2.0.0" },
      declared: [
        { name: "mcp__slack__send" },
        { name: "mcp__slack__run_tool" },
      ],
      calls: {
        mcp__slack__send: "claude-code.slack__send",
        mcp__slack__run_tool: "claude-code.slack__run_tool",
        Bash: "Bash",
      },
    },
    {
      client: "Codex",
      adapter: () => new AppaCodexAdapter(),
      headers: { originator: "codex_exec" },
      declared: [{ name: "send", namespace: "mcp__slack" }],
      calls: { send: "codex.slack__send" },
      namespace: "mcp__slack",
    },
    {
      client: "OpenCode",
      adapter: () => new AppaOpenCodeAdapter(),
      headers: { "user-agent": "opencode/1.18.31" },
      declared: [{ name: "slack_send" }, { name: "linear_create" }],
      calls: {
        slack_send: "opencode.slack__send",
        linear_create: "linear_create",
      },
    },
  ];

  test.each(
    clients,
  )("$client: a local call reaches evaluation under the declared target, a control-named one as an ordinary tool", async ({
    adapter,
    headers,
    declared,
    calls,
    namespace,
  }) => {
    const plugin = new AppaPluginArchestra([adapter()]);
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations: declared,
      internalChat: false,
    });
    const context = pluginContext({ organizationId, identity, headers });
    const evaluate = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockResolvedValue([{ kind: "allow" }]);
    try {
      await plugin.onSessionInit(context);
      for (const [name, canonical] of Object.entries(calls)) {
        evaluate.mockClear();
        await plugin.onToolCalls({
          ...context,
          toolCalls: [
            {
              id: `call-${name}`,
              name,
              ...(namespace ? { namespace } : {}),
              arguments: {},
            },
          ],
        });
        const options = evaluate.mock.calls[0]?.[2];
        expect(options?.canonicalize(name, namespace)).toBe(canonical);
      }
    } finally {
      evaluate.mockRestore();
    }
  });
});

test("a gateway tool the client spells like a local one keeps its attested name", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  config.openappa.enabled = true;
  await GuardrailsDeploymentModel.setEnabled(true);
  const organizationId = (await makeOrganization()).id;
  const user = await makeUser();
  await GuardrailsPolicyModel.save({
    organizationId,
    content: ATTESTED_POLICY,
    contentHash: createHash("sha256").update(ATTESTED_POLICY).digest("hex"),
    updatedBy: user.id,
    expectedRevision: 0,
  });
  const gateway = await makeAgent({
    organizationId,
    name: "gw",
    agentType: "mcp_gateway",
  });
  const plugin = new AppaPluginArchestra([new AppaClaudeCodeAdapter()]);
  const identity = await resolveGatewayToolIdentity({
    organizationId,
    declarations: [
      {
        name: "mcp__slack__send",
        marker: attestToolDescription({
          organizationId,
          gatewayId: gateway.id,
          advertisedName: "mcp__slack__send",
          kind: "t",
          description: undefined,
        }),
      },
    ],
    internalChat: false,
  });
  const context = pluginContext({
    organizationId,
    identity,
    headers: { "user-agent": "claude-cli/2.0.0" },
  });
  const evaluate = vi
    .spyOn(appaService, "evaluateToolCalls")
    .mockResolvedValue([{ kind: "allow" }]);
  try {
    await plugin.onSessionInit(context);
    await plugin.onToolCalls({
      ...context,
      toolCalls: [{ id: "call", name: "mcp__slack__send", arguments: {} }],
    });
    expect(evaluate.mock.calls[0]?.[2]?.canonicalize("mcp__slack__send")).toBe(
      "mcp__slack__send",
    );
  } finally {
    evaluate.mockRestore();
  }
});

const ATTESTED_POLICY = `include = []

[server_aliases]
slack = ["claude-code.slack"]

[policy]
version = 2

[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"

[externals.annotators.noop]
url = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"
`;

function pluginContext(params: {
  organizationId: string;
  identity: AppaTrustedContext["toolIdentity"];
  headers: Record<string, string>;
}): LlmProxyRequestContext {
  return {
    requestId: "detected-request",
    organizationId: params.organizationId,
    profileId: "profile",
    provider: "anthropic",
    interactionType: "anthropic:messages",
    model: "model",
    streaming: false,
    headers: params.headers,
    requestBody: {},
    resources: new Map([
      [
        APPA_PLUGIN_TRUSTED_CONTEXT,
        {
          session: {
            organization_id: params.organizationId,
            caller_id: "user:person",
            session_id: "session",
          },
          profileId: "profile",
          toolIdentity: params.identity,
          request: {
            tools: {
              control: { name: "archestra__execute_remedy_plan" },
              notice: { name: "archestra__get_remedy_plans" },
              askUser: { name: "archestra__ask_user" },
              platformToolNames: new Set(["archestra__ask_user"]),
            },
            session: {},
            spellings: new Map(),
            customTools: new Set(),
            namespaces: new Map(),
            foreignControlTools: [],
          },
        },
      ],
    ]),
  };
}
