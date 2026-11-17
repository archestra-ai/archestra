import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { Client } from "pg";
import { vi } from "vitest";
import config from "@/config";
import * as database from "@/database";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { mintChildReturnMarker } from "@/openappa/child-return";
import { prepareAppaRequest } from "@/openappa/request";
import { executeRemedyByOffer } from "@/openappa/service";
import type {
  LlmProxyRequestContext,
  LlmProxyToolCallsContext,
} from "@/proxy/plugins/registry";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT, type AppaTrustedContext } from "./types";

setupTestCacheManager();

const originalEnabled = config.openappa.enabled;
const originalSecret = config.openappa.offerSigningSecret;
afterEach(() => {
  config.openappa.enabled = originalEnabled;
  config.openappa.offerSigningSecret = originalSecret;
  vi.restoreAllMocks();
});

// The native runtime keeps its ledger in a real PostgreSQL server; the test
// database is PGlite, which it cannot reach.
test.skipIf(!process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL)(
  "a Claude Code side request that omits a running subagent call does not end the subagent",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const databaseUrl = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("Isolated native test ledger required");
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      databaseUrl,
    );
    config.openappa.enabled = true;
    config.openappa.offerSigningSecret = "claude-code-child-stop-secret-0123";
    await GuardrailsDeploymentModel.setEnabled(true);
    const organizationId = (await makeOrganization()).id;
    const user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    await installLedgerPolicy({
      organizationId,
      userId: user.id,
      databaseUrl,
      content: `[policy]\nversion = 2\n[[policy.tool]]\nname = "host/archestra/Agent"\ndelta = {}\n[[policy.tool]]\nname = "host/archestra/Bash"\ndelta = {}\n[policy.deployment]\ncontext_control = true\n`,
    });
    const callerId = `user:${user.id}`;
    const nativeSessionId = randomUUID();
    const parentId = `${callerId}|${nativeSessionId}`;
    const childId = `${parentId}:a1`;
    const request = (params: {
      agentId?: string;
      messages: unknown[];
    }): LlmProxyRequestContext =>
      claudeCodeRequest({
        organizationId,
        callerId,
        sessionId: parentId,
        headers: {
          "user-agent": "claude-cli/2.1.0 (external, cli)",
          "x-claude-code-session-id": nativeSessionId,
          ...(params.agentId
            ? { "x-claude-code-agent-id": params.agentId }
            : {}),
        },
        body: { messages: params.messages, tools: [BASH_TOOL] },
      });

    const plugin = new AppaPluginArchestra([new AppaClaudeCodeAdapter()]);
    const parent = request({
      messages: [{ role: "user", content: "Find out why the build fails." }],
    });
    await plugin.onSessionInit(parent);
    await plugin.onToolResults({ ...parent, toolResults: [] });
    // What the model's declare-ahead remedy call runs at the gateway.
    const declare = { label: {} };
    const declared = await executeRemedyByOffer({
      organizationId,
      callerId,
      sessionId: parentId,
      toolCallId: "toolu-declare",
      controlToolName: "archestra__execute_remedy_plan",
      originalArguments: JSON.stringify(declare),
      args: declare,
    });
    expect(declared.result.isError).toBeFalsy();
    const spawned = await plugin.onToolCalls(
      toolCalls(parent, [
        {
          id: "toolu-spawn",
          name: "Agent",
          arguments: {
            description: "build",
            prompt: "Run the tests and report the failures.",
            subagent_type: "general-purpose",
          },
        },
      ]),
    );
    if (spawned?.decision !== "allow") throw new Error("expected the spawn");
    expect(spawned.toolCalls.map((call) => call.name)).toEqual(["Agent"]);
    const markedPrompt = (spawned.toolCalls[0].arguments as { prompt: string })
      .prompt;
    const opening = () => ({ role: "user", content: markedPrompt });
    const started = request({ agentId: "a1", messages: [opening()] });
    await plugin.onSessionInit(started);
    await plugin.onToolResults({ ...started, toolResults: [] });
    const ran = await plugin.onToolCalls(
      toolCalls(started, [
        { id: "toolu-pytest", name: "Bash", arguments: { command: "pytest" } },
      ]),
    );
    expect(ran).toMatchObject({
      decision: "allow",
      toolCalls: [{ id: "toolu-pytest", name: "Bash" }],
    });
    await plugin.onCleanup(started);

    // Claude Code asks something on the side while pytest still runs: the
    // body drops the unresolved tool_use and the model answers in text.
    const side = request({
      agentId: "a1",
      messages: [
        opening(),
        { role: "user", content: "Summarize what you are doing in one line." },
      ],
    });
    await plugin.onSessionInit(side);
    await plugin.onToolResults({ ...side, toolResults: [] });
    expect(
      await plugin.onBufferedModelResponse({
        ...side,
        response: {},
        responseText: "Running the test suite",
      }),
    ).toEqual({ decision: "release" });
    await plugin.onCleanup(side);

    const finished = request({
      agentId: "a1",
      messages: [
        opening(),
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-pytest",
              name: "Bash",
              input: { command: "pytest" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-pytest",
              content: "2 failed, 40 passed",
            },
          ],
        },
      ],
    });
    await plugin.onSessionInit(finished);
    const reported = await plugin.onToolResults({
      ...finished,
      toolResults: [
        {
          id: "toolu-pytest",
          name: "Bash",
          content: "2 failed, 40 passed",
          isError: false,
        },
      ],
    });
    // The runtime reports the call's own output, not a refusal.
    expect(reported).toEqual({
      toolResultUpdates: { "toolu-pytest": "2 failed, 40 passed" },
    });
    const reply = "Two tests fail in test_build.py.";
    expect(
      await plugin.onBufferedModelResponse({
        ...finished,
        response: {},
        responseText: reply,
      }),
    ).toEqual({
      decision: "replace",
      responseText: `${reply}\n\n${mintChildReturnMarker({
        organizationId,
        callerId,
        parentId,
        childId,
        childNativeId: "a1",
        spawnCallId: "toolu-spawn",
        value: reply,
      })}`,
    });
    await plugin.onCleanup(finished);
    await plugin.onCleanup(parent);
  },
);

const BASH_TOOL = {
  name: "Bash",
  description: "Run a shell command",
  input_schema: { type: "object", properties: {} },
};

/** Compile the policy here, then copy it with its organization to the ledger. */
async function installLedgerPolicy(params: {
  organizationId: string;
  userId: string;
  databaseUrl: string;
  content: string;
}) {
  const revision = await guardrailsPolicyService.get(params.organizationId);
  await guardrailsPolicyService.update({
    organizationId: params.organizationId,
    userId: params.userId,
    expectedRevision: revision.revision,
    content: params.content,
  });
  await openappaBatteriesService.getEffectivePolicy(params.organizationId);
  const policy = await OpenAppaEffectivePolicyModel.find(params.organizationId);
  if (!policy) throw new Error("Expected compiled test policy");
  const ledger = new Client({ connectionString: params.databaseUrl });
  await ledger.connect();
  try {
    await ledger.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING",
      [params.organizationId],
    );
    await ledger.query(
      "INSERT INTO openappa_effective_policies (organization_id, content, content_hash, root_revision, install_fingerprint, compiled_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        params.organizationId,
        policy.content,
        policy.contentHash,
        policy.rootRevision,
        policy.installFingerprint,
        policy.compiledAt,
      ],
    );
  } finally {
    await ledger.end();
  }
}

/** A Claude Code request as the proxy prepares it: markers read, then stripped. */
function claudeCodeRequest(params: {
  organizationId: string;
  callerId: string;
  sessionId: string;
  headers: Record<string, string>;
  body: unknown;
}): LlmProxyRequestContext {
  const canonicalize = (name: string) => name;
  const trusted: AppaTrustedContext = {
    session: {
      organization_id: params.organizationId,
      caller_id: params.callerId,
      session_id: params.sessionId,
    },
    profileId: "profile",
    toolIdentity: {
      canonicalize,
      attestationOf: () => undefined,
      looseRunToolDispatch: false,
    },
    request: {
      ...prepareAppaRequest({
        body: params.body,
        interactionType: "anthropic:messages",
        identity: {
          mode: "compat",
          gatewayConnected: true,
          canonicalize,
          attestationOf: () => undefined,
          verified: [],
          unverifiedMarkerCount: 0,
        },
      }),
      tools: {
        control: { name: "archestra__execute_remedy_plan" },
        notice: { name: "archestra__get_remedy_plans" },
        askUser: undefined,
        platformToolNames: new Set(),
        namespaces: new Map(),
      },
    },
  };
  return {
    requestId: randomUUID(),
    organizationId: params.organizationId,
    profileId: "profile",
    provider: "anthropic",
    interactionType: "anthropic:messages",
    model: "model",
    streaming: false,
    headers: params.headers,
    requestBody: params.body,
    resources: new Map([[APPA_PLUGIN_TRUSTED_CONTEXT, trusted]]),
  };
}

function toolCalls(
  context: LlmProxyRequestContext,
  calls: LlmProxyToolCallsContext["toolCalls"],
): LlmProxyToolCallsContext {
  return { ...context, toolCalls: calls, canRewriteToolCalls: true };
}
