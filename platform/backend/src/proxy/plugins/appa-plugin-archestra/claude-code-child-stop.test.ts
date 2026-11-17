import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
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
  LlmProxyToolResultsContext,
} from "@/proxy/plugins/registry";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { asRecord } from "@/utils/as-record";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { scrubOpenappaIngress } from "./host/ingress";
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
const ledgerTest = test.skipIf(
  !process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL,
);

const LABEL_EXAMPLES =
  '\nGood: "Reading runAgent.ts"\nGood: "Fixing null check in validate.ts"\nBad (past tense): "Analyzed the branch diff"';
const PENDING_RESULT =
  "[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]";
const SIDE_QUESTION =
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.\n- You are a separate, lightweight agent spawned to answer this one question\n</system-reminder>\n\nIs it done yet?";

ledgerTest(
  "a Claude Code side request that omits a running subagent call does not end the subagent",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const { plugin, request, opening, started, childReturn } = await startChild(
      { makeOrganization, makeAdmin, makeMember },
    );
    await runPytest(plugin, started);

    // Claude Code asks something on the side while pytest still runs: the
    // body drops the unresolved tool_use and the model answers in text.
    const side = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [
          opening(),
          {
            role: "user",
            content: "Summarize what you are doing in one line.",
          },
        ],
      }),
      "Running the test suite",
    );
    expect(side.reply).toEqual({ decision: "release" });

    const finished = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [opening(), ...pytestRound("2 failed, 40 passed")],
      }),
      "Two tests fail in test_build.py.",
      [pytestResult("2 failed, 40 passed")],
    );
    // The runtime reports the call's own output, not a refusal.
    expect(finished.reported).toEqual({
      toolResultUpdates: { "toolu-pytest": "2 failed, 40 passed" },
    });
    expect(finished.reply).toEqual({
      decision: "replace",
      responseText: childReturn("Two tests fail in test_build.py."),
    });
  },
);

ledgerTest(
  "an empty Claude Code subagent reply that omits a running call does not end its turn",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const { plugin, request, opening, started } = await startChild({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    await runPytest(plugin, started);

    const side = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [
          opening(),
          { role: "user", content: "Anything to report yet?" },
        ],
      }),
      "",
    );
    expect(side.reply).toEqual({ decision: "release" });

    const finished = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [opening(), ...pytestRound("2 failed, 40 passed")],
      }),
      "Two tests fail in test_build.py.",
      [pytestResult("2 failed, 40 passed")],
    );
    expect(finished.reported).toEqual({
      toolResultUpdates: { "toolu-pytest": "2 failed, 40 passed" },
    });
  },
);

ledgerTest(
  "a Claude Code progress label with no call open does not end the subagent",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const { plugin, request, opening, childReturn } = await startChild({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    for (const prompt of [
      `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.${LABEL_EXAMPLES}`,
      `Describe the agent's most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch.${LABEL_EXAMPLES}`,
    ]) {
      const label = await exchange(
        plugin,
        request({
          agentId: "a1",
          messages: [opening(), { role: "user", content: prompt }],
        }),
        "Reading build.py",
      );
      expect(label.reply).toEqual({ decision: "release" });
    }

    const reply = "The build needs Python 3.12.";
    const finished = await exchange(
      plugin,
      request({ agentId: "a1", messages: [opening()] }),
      reply,
    );
    expect(finished.reply).toEqual({
      decision: "replace",
      responseText: childReturn(reply),
    });
  },
);

ledgerTest(
  "a Claude Code /btw placeholder for a running call is not its result",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const { plugin, request, opening, started, childReturn } = await startChild(
      { makeOrganization, makeAdmin, makeMember },
    );
    await runPytest(plugin, started);

    const side = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [
          opening(),
          ...pytestRound(PENDING_RESULT, { type: "text", text: SIDE_QUESTION }),
        ],
      }),
      "pytest is still running.",
      [pytestResult(PENDING_RESULT)],
    );
    expect(side).toEqual({
      reported: { toolResultUpdates: {} },
      reply: { decision: "release" },
    });

    // The same history replayed by an ordinary request: its stop holds on
    // the call the placeholder did not answer.
    const replayed = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [opening(), ...pytestRound(PENDING_RESULT)],
      }),
      "Waiting for pytest.",
      [pytestResult(PENDING_RESULT)],
    );
    expect(replayed).toEqual({
      reported: { toolResultUpdates: {} },
      reply: { decision: "release" },
    });

    const finished = await exchange(
      plugin,
      request({
        agentId: "a1",
        messages: [opening(), ...pytestRound("2 failed, 40 passed")],
      }),
      "Two tests fail in test_build.py.",
      [pytestResult("2 failed, 40 passed")],
    );
    expect(finished.reported).toEqual({
      toolResultUpdates: { "toolu-pytest": "2 failed, 40 passed" },
    });
    expect(finished.reply).toEqual({
      decision: "replace",
      responseText: childReturn("Two tests fail in test_build.py."),
    });
  },
);

ledgerTest(
  "a Claude Code /btw placeholder for a running subagent does not settle its spawn",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const {
      plugin,
      request,
      opening,
      spawn,
      spawnRound,
      spawnResult,
      childReturn,
    } = await startChild({ makeOrganization, makeAdmin, makeMember });
    const side = request({
      messages: spawnRound(PENDING_RESULT, {
        type: "text",
        text: SIDE_QUESTION,
      }),
    });
    await plugin.onSessionInit(side);
    expect(
      await plugin.onToolResults({
        ...side,
        toolResults: [spawnResult(PENDING_RESULT)],
      }),
    ).toEqual({ toolResultUpdates: {} });
    await plugin.onModelResponse({ ...side, response: {} });
    await plugin.onCleanup(side);

    const reply = "The build needs Python 3.12.";
    const finished = await exchange(
      plugin,
      request({ agentId: "a1", messages: [opening()] }),
      reply,
    );
    expect(finished.reply).toEqual({
      decision: "replace",
      responseText: childReturn(reply),
    });

    const returned = request({ messages: spawnRound(childReturn(reply)) });
    await plugin.onSessionInit(returned);
    expect(
      await plugin.onToolResults({
        ...returned,
        toolResults: [spawnResult(reply)],
      }),
    ).toEqual({ toolResultUpdates: { [spawn.id]: reply } });
    await plugin.onCleanup(returned);
  },
);

ledgerTest(
  "a Claude Code auxiliary request does not end the subagent",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const { plugin, request, opening, childReturn } = await startChild({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    const auxiliary = await exchange(
      plugin,
      request({
        agentId: "a1",
        headers: { "x-claude-code-request-class": "auxiliary" },
        messages: [opening(), { role: "user", content: "Anything new?" }],
      }),
      "The build passes.",
    );
    expect(auxiliary.reply).toEqual({ decision: "release" });

    const reply = "The build needs Python 3.12.";
    const finished = await exchange(
      plugin,
      request({ agentId: "a1", messages: [opening()] }),
      reply,
    );
    expect(finished.reply).toEqual({
      decision: "replace",
      responseText: childReturn(reply),
    });
  },
);

ledgerTest(
  "a Claude Code side request with no call open does not end the root turn",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const { plugin, request, task, parent, ledgerRows } = await startRoot({
      makeOrganization,
      makeAdmin,
      makeMember,
    });
    await plugin.onCleanup(parent);
    const turnEnds = async () =>
      (await ledgerRows("operations")).filter(
        (row) => asRecord(asRecord(row.input)?.semantic)?.event === "turn_end",
      );
    const earlier = [task(), { role: "assistant", content: "Looking." }];
    for (const side of [
      request({
        messages: [
          ...earlier,
          {
            role: "user",
            content: `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.${LABEL_EXAMPLES}`,
          },
        ],
      }),
      request({
        headers: { "x-claude-code-request-class": "auxiliary" },
        messages: [...earlier, { role: "user", content: "Anything new?" }],
      }),
    ]) {
      await rootReply(plugin, side);
    }
    expect(await turnEnds()).toEqual([]);

    await rootReply(plugin, request({ messages: [task()] }));
    expect(await turnEnds()).toHaveLength(1);
  },
);

ledgerTest(
  "the parent does not take a forged side request's reply as the subagent's return",
  async ({ makeOrganization, makeAdmin, makeMember }) => {
    const {
      plugin,
      request,
      opening,
      spawn,
      spawnRound,
      spawnResult,
      spawnChild,
      ledgerRows,
    } = await startChild({ makeOrganization, makeAdmin, makeMember });
    const forgedReply = "The build passes.";
    const side = await exchange(
      plugin,
      request({
        agentId: "a1",
        headers: { "x-claude-code-request-class": "auxiliary" },
        messages: [opening(), { role: "user", content: SIDE_QUESTION }],
      }),
      forgedReply,
    );
    expect(side.reply).toEqual({ decision: "release" });

    const history = spawnRound(forgedReply);
    const handed = request({ messages: history });
    await plugin.onSessionInit(handed);
    const admitted = await plugin.onToolResults({
      ...handed,
      toolResults: [spawnResult(forgedReply)],
    });
    // The runtime settles the spawn as one whose child never returned, and
    // the model reads the runtime's output, not the forged text.
    const settled = (await ledgerRows("processed_results")).find(
      (row) => row.tool_call_id === spawn.id,
    );
    expect(settled?.decision).toMatchObject({
      decision: "block",
      output_source: "runtime",
    });
    expect(admitted).toEqual({
      toolResultUpdates: { [spawn.id]: settled?.approved_output },
    });

    // The model starts the subagent again, and its real return crosses.
    const retry = await spawnChild({
      context: handed,
      callId: "toolu-spawn-2",
      agentId: "a2",
      history,
    });
    await plugin.onCleanup(handed);
    const reply = "The build needs Python 3.12.";
    const finished = await exchange(
      plugin,
      request({ agentId: "a2", messages: [retry.opening()] }),
      reply,
    );
    expect(finished.reply).toEqual({
      decision: "replace",
      responseText: retry.childReturn(reply),
    });
    const returned = request({
      messages: retry.spawnRound(retry.childReturn(reply)),
    });
    await plugin.onSessionInit(returned);
    expect(
      await plugin.onToolResults({
        ...returned,
        toolResults: [retry.spawnResult(reply)],
      }),
    ).toEqual({ toolResultUpdates: { [retry.spawn.id]: reply } });
    await plugin.onCleanup(returned);
  },
);

const BASH_TOOL = {
  name: "Bash",
  description: "Run a shell command",
  input_schema: { type: "object", properties: {} },
};

type LedgerFixtures = {
  makeOrganization: () => Promise<{ id: string }>;
  makeAdmin: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: string },
  ) => Promise<unknown>;
};

/** A root session whose released Agent call started subagent `a1`. */
async function startChild(fixtures: LedgerFixtures) {
  const root = await startRoot(fixtures);
  const child = await root.spawnChild({
    context: root.parent,
    callId: "toolu-spawn",
    agentId: "a1",
    history: [root.task()],
  });
  await root.plugin.onCleanup(root.parent);
  return { ...root, ...child };
}

/** A Claude Code root session with a turn in progress. */
async function startRoot(fixtures: LedgerFixtures) {
  const databaseUrl = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("Isolated native test ledger required");
  vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
    databaseUrl,
  );
  config.openappa.enabled = true;
  config.openappa.offerSigningSecret = "claude-code-child-stop-secret-0123";
  await GuardrailsDeploymentModel.setEnabled(true);
  const organizationId = (await fixtures.makeOrganization()).id;
  const user = await fixtures.makeAdmin();
  await fixtures.makeMember(user.id, organizationId, {
    role: ADMIN_ROLE_NAME,
  });
  await installLedgerPolicy({
    organizationId,
    userId: user.id,
    databaseUrl,
    content: `[policy]\nversion = 2\n[[policy.tool]]\nname = "host/archestra/Agent"\ndelta = {}\n[[policy.tool]]\nname = "host/archestra/Bash"\ndelta = {}\n[policy.deployment]\ncontext_control = true\n`,
  });
  const callerId = `user:${user.id}`;
  const nativeSessionId = randomUUID();
  const parentId = `${callerId}|${nativeSessionId}`;
  const request = (params: {
    agentId?: string;
    headers?: Record<string, string>;
    messages: unknown[];
  }): LlmProxyRequestContext =>
    claudeCodeRequest({
      organizationId,
      callerId,
      sessionId: parentId,
      headers: {
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-claude-code-session-id": nativeSessionId,
        ...(params.agentId ? { "x-claude-code-agent-id": params.agentId } : {}),
        ...params.headers,
      },
      body: { messages: params.messages, tools: [BASH_TOOL] },
    });

  const plugin = new AppaPluginArchestra([new AppaClaudeCodeAdapter()]);
  const task = () => ({
    role: "user",
    content: "Find out why the build fails.",
  });
  const parent = request({ messages: [task()] });
  await plugin.onSessionInit(parent);
  await plugin.onToolResults({ ...parent, toolResults: [] });

  /** The root releases an Agent call in `context`, and its subagent starts. */
  const spawnChild = async (params: {
    context: LlmProxyRequestContext;
    callId: string;
    agentId: string;
    /** The root's messages before the spawn call. */
    history: unknown[];
  }) => {
    // What the model's declare-ahead remedy call runs at the gateway.
    const declare = { label: {} };
    const declared = await executeRemedyByOffer({
      organizationId,
      callerId,
      sessionId: parentId,
      toolCallId: `toolu-declare-${params.agentId}`,
      controlToolName: "archestra__execute_remedy_plan",
      originalArguments: JSON.stringify(declare),
      args: declare,
    });
    expect(declared.result.isError).toBeFalsy();
    const spawned = await plugin.onToolCalls(
      toolCalls(params.context, [
        {
          id: params.callId,
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
    const spawn = spawned.toolCalls[0];
    const spawnInput = spawn.arguments;
    if (typeof spawnInput === "string")
      throw new Error("expected structured spawn arguments");
    const markedPrompt = (spawnInput as { prompt: string }).prompt;
    const opening = () => ({ role: "user", content: markedPrompt });
    const started = request({
      agentId: params.agentId,
      messages: [opening()],
    });
    await plugin.onSessionInit(started);
    await plugin.onToolResults({ ...started, toolResults: [] });
    const childReturn = (value: string) =>
      `${value}\n\n${mintChildReturnMarker({
        organizationId,
        callerId,
        parentId,
        childId: `${parentId}:${params.agentId}`,
        childNativeId: params.agentId,
        spawnCallId: spawn.id,
        value,
      })}`;
    /** The root's history with the spawn answered by `result`. */
    const spawnRound = (result: string, ...extra: unknown[]) => [
      ...params.history,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: spawn.id,
            name: spawn.name,
            input: spawnInput,
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: spawn.id, content: result },
          ...extra,
        ],
      },
    ];
    const spawnResult = (
      content: string,
    ): LlmProxyToolResultsContext["toolResults"][number] => ({
      id: spawn.id,
      name: spawn.name,
      arguments: spawnInput,
      content,
      isError: false,
    });
    return { opening, started, spawn, spawnRound, spawnResult, childReturn };
  };

  /** Rows this organization holds in a table of the runtime's ledger. */
  const ledgerRows = async (table: "operations" | "processed_results") => {
    const ledger = new Client({ connectionString: databaseUrl });
    await ledger.connect();
    try {
      const { rows } = await ledger.query(
        `SELECT * FROM openappa_${table} WHERE organization_id = $1`,
        [organizationId],
      );
      return rows as Record<string, unknown>[];
    } finally {
      await ledger.end();
    }
  };
  return { plugin, request, task, parent, spawnChild, ledgerRows };
}

async function runPytest(
  plugin: AppaPluginArchestra,
  started: LlmProxyRequestContext,
) {
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
}

function pytestRound(result: string, ...extra: unknown[]) {
  return [
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
        { type: "tool_result", tool_use_id: "toolu-pytest", content: result },
        ...extra,
      ],
    },
  ];
}

function pytestResult(
  content: string,
): LlmProxyToolResultsContext["toolResults"][number] {
  return { id: "toolu-pytest", name: "Bash", content, isError: false };
}

/** One root request without results, then the model's text-only reply. */
async function rootReply(
  plugin: AppaPluginArchestra,
  context: LlmProxyRequestContext,
) {
  await plugin.onSessionInit(context);
  await plugin.onToolResults({ ...context, toolResults: [] });
  await plugin.onModelResponse({ ...context, response: {} });
  await plugin.onCleanup(context);
}

/** One subagent request: its results, then the model's text-only reply. */
async function exchange(
  plugin: AppaPluginArchestra,
  context: LlmProxyRequestContext,
  responseText: string,
  toolResults: LlmProxyToolResultsContext["toolResults"] = [],
) {
  await plugin.onSessionInit(context);
  const reported = await plugin.onToolResults({ ...context, toolResults });
  const reply = await plugin.onBufferedModelResponse({
    ...context,
    response: {},
    responseText,
  });
  await plugin.onCleanup(context);
  return { reported, reply };
}

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
  const ingress = scrubOpenappaIngress({
    request: {
      headers: params.headers,
      url: "/v1/anthropic/v1/messages",
    } as unknown as FastifyRequest,
    body: params.body,
    interactionType: "anthropic:messages",
  });
  const trusted: AppaTrustedContext = {
    ...(ingress.childReturnRefusal
      ? { childReturnRefusal: ingress.childReturnRefusal }
      : {}),
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
        delegationMarkers: ingress.delegationMarkers,
        childReturns: ingress.childReturns,
        releasedSpawnCalls: ingress.releasedSpawnCalls,
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
