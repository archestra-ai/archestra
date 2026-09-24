/**
 * The OpenAPPA root tool flow, end to end, against the real stack.
 *
 * Until now this was covered only by the manual runbook in
 * `e2e-tests/fixtures/appa-root-flow/README.md`, whose "Archestra Chat"
 * scenario this automates. Everything here is real — the platform container,
 * PostgreSQL, the OpenAPPA native runtime, the MCP gateway, the LLM proxy and
 * Chat's own agentic loop. The only stubbed boundary is the upstream Anthropic
 * Messages API, served by WireMock.
 *
 * What it proves, in order:
 *
 *   1. The model proposes `archestra__list_skills`.
 *   2. OpenAPPA denies it and the proxy replaces that call — in its own
 *      position, under its own provider call id — with a call to
 *      `archestra__get_remedy_plans` carrying `{tool, arguments, ruling, notice}`.
 *   3. Chat executes the notice tool; its result is the runtime's rendered
 *      ruling, which names an `offer_id`.
 *   4. The model calls `archestra__execute_remedy_plan` with that exact
 *      `offer_id`, and the runtime authorizes it.
 *   5. The model retries the original call; it is released and returns the
 *      real result.
 *
 * The second test repeats the flow with the model calling the restricted tool
 * through `archestra__run_tool`, the only path a `search_and_run_only` agent
 * has: the policy names the dispatch's target, so the denial notice and the
 * restored history must name it too, while the released retry stays the
 * wrapper the client can execute.
 *
 * This spec requires a stack booted with `ARCHESTRA_OPENAPPA_ENABLED=true`.
 * It lives in the `openappa` Playwright project for exactly that reason and
 * must never be added to another project's testMatch — see the note on
 * `testPatterns.openappa` in playwright.config.ts. The second switch —
 * deployment-wide, database-backed, off on a fresh stack — the test turns on
 * itself and restores afterwards.
 */
import { randomUUID } from "node:crypto";
import { WIREMOCK_BASE_URL } from "../../consts";
import { ensureWireMockAnthropicChatProvider } from "../../utils";
import { expect, test } from "../api-fixtures";
import {
  absent,
  addWireMockMapping,
  anthropicMapping,
  asObject,
  assistantText,
  collect,
  findToolId,
  type GuardrailsPolicy,
  outputFor,
  readOfferId,
  readPolicy,
  runChatTurn,
  type ToolInput,
  type ToolOutput,
  textAnswerEvents,
  textOf,
  toolUseEvents,
  writePolicy,
} from "./helpers";

// Both scenarios mutate the deployment-wide switch and the shared policy, so
// they cannot run beside each other under the project's fullyParallel default.
test.describe.configure({ mode: "serial" });

const NOTICE_TOOL = "archestra__get_remedy_plans";
const CONTROL_TOOL = "archestra__execute_remedy_plan";
const BLOCKED_TOOL = "archestra__list_skills";
const DISPATCH_TOOL = "archestra__run_tool";

/**
 * Extracts the live `offer_id` from the ruling the runtime wrote, which is in
 * the request body WireMock is answering.
 *
 * The id is minted at runtime and is unknowable when the stub is authored, so
 * the turn-2 stub reads it out of the incoming history with WireMock's
 * Handlebars `regexExtract` (single-argument form: it returns the whole match
 * of the first `find()`). The ruling renders the remedy as
 *
 *     archestra__execute_remedy_plan(offer_id: "<16 lowercase hex chars>")
 *
 * (`appa-runtime/src/engine.rs`, `remedy_instruction`; the `archestra__`
 * prefix is the proxy respelling the runtime's canonical control-tool name),
 * and it reaches the provider inside a JSON string, so the quote arrives as
 * the two bytes `\"`.
 *
 * The lookbehind is deliberately written without a single backslash — `[(]`
 * for the paren and `..` for the `\"` pair — so nothing in it can be eaten by
 * Handlebars' own string-literal parsing, and it stays fixed-length, which is
 * what Java's regex engine requires of a lookbehind.
 */
const OFFER_ID_TEMPLATE =
  "{{regexExtract request.body '(?<=execute_remedy_plan[(]offer_id: ..)[0-9a-f]+'}}";

/**
 * Stand-in for the template inside the stub's JSON, swapped for the real
 * Handlebars expression after serialization. Writing the expression straight
 * into the tool input would bury it under two rounds of JSON escaping (the
 * SSE event, then the `input_json_delta` payload), and WireMock renders the
 * body as plain text — it would never see the expression it has to evaluate.
 */
const OFFER_ID_PLACEHOLDER = "APPA_OFFER_ID_FROM_RULING";

/** The single tool the test policy restricts, by the same audience delta the runbook uses. */
const TEST_POLICY = `[policy]
version = 2
trust_chain = ["untrusted", "trusted"]

# Listing the skills narrows the session's audience, so the call is blocked
# and offered an acceptance plan. Deliberately no [externals] block: with no
# authority and no sanitizer to consult, this policy needs no sidecar and the
# flow stays a pure runtime negotiation.
[[policy.tool]]
name = "${BLOCKED_TOOL}"
delta = { audience = ["lab@archestra.local"] }
`;

test("denies a tool call, rules on it, and releases it after the model executes the remedy", async ({
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(180_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const marker = `appa-root-remedy-e2e-${suffix}`;
  // The provider call ids are this run's turn discriminators. Content cannot
  // serve: the proxy strips the notice tool from the declaration it forwards
  // and restores every notice call back to the original, so `get_remedy_plans`
  // never appears upstream, while `execute_remedy_plan` appears in EVERY
  // request as a declared tool. These ids come back verbatim in the history,
  // and being per-run keeps parallel workers from cross-matching.
  const blockedCallId = `toolu_appa_${suffix}_blocked`;
  const remedyCallId = `toolu_appa_${suffix}_remedy`;
  const retryCallId = `toolu_appa_${suffix}_retry`;
  const finalAnswer = `OpenAPPA root remedy flow ${suffix} completed end to end.`;

  const wireMockMappingIds: string[] = [];
  let originalPolicy: GuardrailsPolicy | undefined;
  let deploymentWasEnabled: boolean | undefined;
  let agentId: string | undefined;
  let conversationId: string | undefined;

  try {
    // --- deployment switch -------------------------------------------------
    // Enforcement needs two switches: the container's ARCHESTRA_OPENAPPA_ENABLED
    // and this deployment-wide one, which lives in the database and is off
    // until an operator turns it on. A freshly booted stack has no row, so the
    // flag alone enforces nothing. Flip it the way an operator does.
    const deploymentResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/guardrails-deployment",
    });
    const deployment = (await deploymentResponse.json()) as {
      enabled: boolean;
      featureEnabled: boolean;
    };
    expect(
      deployment.featureEnabled,
      "the stack was booted without ARCHESTRA_OPENAPPA_ENABLED=true — the openappa Playwright project requires it",
    ).toBe(true);
    deploymentWasEnabled = deployment.enabled;
    if (!deployment.enabled) {
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: "/api/guardrails-deployment",
        data: { enabled: true },
      });
    }

    // --- policy ------------------------------------------------------------
    // Read first so the restore in `finally` puts the deployment's own policy
    // back, whatever it was.
    originalPolicy = await readPolicy(makeApiRequest, request);
    await writePolicy(makeApiRequest, request, {
      content: TEST_POLICY,
      expectedRevision: originalPolicy.revision,
    });

    // --- agent, tool, provider --------------------------------------------
    const agentResponse = await createAgent(
      request,
      `OpenAPPA root flow ${suffix}`,
      "personal",
    );
    agentId = ((await agentResponse.json()) as { id: string }).id;

    const blockedToolId = await findToolId(
      makeApiRequest,
      request,
      BLOCKED_TOOL,
    );
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${agentId}/tools/${blockedToolId}`,
      data: {},
    });

    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agentId}`,
      data: { llmApiKeyId: apiKeyId, modelId: runtimeModel.dbId },
    });

    // Cheap, precise failure if OpenAPPA is not actually enforcing: the
    // gateway advertises both APPA tools implicitly, and only then. Without
    // this the run would instead fail deep inside the proxy with a 400 about
    // an undeclared control tool.
    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat/agents/${agentId}/mcp-tools`,
    });
    const advertised = ((await toolsResponse.json()) as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(
      advertised,
      "the gateway advertises both APPA tools only while OpenAPPA enforces — the feature flag and the deployment switch are both on by this point",
    ).toEqual(expect.arrayContaining([NOTICE_TOOL, CONTROL_TOOL]));
    expect(advertised).toContain(BLOCKED_TOOL);

    // --- the scripted provider turns ---------------------------------------
    for (const mapping of [
      proposeBlockedCallMapping({ marker, blockedCallId }),
      executeRemedyMapping({ marker, blockedCallId, remedyCallId }),
      retryBlockedCallMapping({ marker, remedyCallId, retryCallId }),
      finalAnswerMapping({ marker, retryCallId, finalAnswer }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    // --- the conversation --------------------------------------------------
    // After the policy is installed: a conversation keeps the policy it
    // started with.
    const conversationResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat/conversations",
      // An explicit selection keeps saved member preferences from routing this
      // fixture to a real provider instead of WireMock on retained stacks.
      data: { agentId, modelId: runtimeModel.dbId, chatApiKeyId: apiKeyId },
    });
    const conversation = (await conversationResponse.json()) as { id: string };
    expect(conversation).toMatchObject({
      modelId: runtimeModel.dbId,
      chatApiKeyId: apiKeyId,
    });
    conversationId = conversation.id;

    const events = await runChatTurn(request, {
      conversationId,
      prompt:
        `${marker}: List the available skills using the list_skills tool. ` +
        "If the call is blocked, read the remedy plans you are given, execute " +
        "the offered plan with execute_remedy_plan using its exact offer_id, " +
        "and then retry list_skills.",
    });

    const toolInputs = collect<ToolInput>(events, "tool-input-available");
    const toolOutputs = collect<ToolOutput>(events, "tool-output-available");

    // 1-2. The denied call reached the client as the notice, in its own
    //      position and under its own provider call id.
    expect(toolInputs.map((call) => call.toolName)).toEqual([
      NOTICE_TOOL,
      CONTROL_TOOL,
      BLOCKED_TOOL,
    ]);

    const [notice, remedy, retry] = toolInputs;
    expect(notice.toolCallId).toBe(blockedCallId);
    const noticeInput = notice.input as {
      tool: string;
      arguments: unknown;
      ruling: string;
      notice: { v: number; call_id: string };
    };
    expect(noticeInput.tool).toBe(BLOCKED_TOOL);
    expect(asObject(noticeInput.arguments)).toEqual({});
    // The ruling travels in the clear: a client-side judge reads a call's
    // arguments and not the tool's result, so it must find the policy's own
    // explanation there rather than an encoded blob.
    expect(noticeInput.ruling).toContain("[appa] Blocked");
    expect(noticeInput.notice).toEqual({ v: 1, call_id: blockedCallId });

    // 3. Executing the notice returned the runtime's rendered ruling, which
    //    names an offer.
    const ruling = textOf(outputFor(toolOutputs, notice.toolCallId));
    expect(ruling).toContain("[appa] Blocked");
    const offerId = readOfferId(ruling);

    // 4. The model spent that exact offer, and the runtime authorized it.
    expect((remedy.input as { offer_id: string }).offer_id).toBe(offerId);
    const remedyOutput = textOf(outputFor(toolOutputs, remedy.toolCallId));
    expect(remedyOutput).not.toContain("[appa] Blocked");
    expect(remedyOutput).not.toContain("Tool output withheld");

    // 5. The retried call was released and returned the real result, not a
    //    ruling and not a withheld placeholder.
    expect(retry.toolCallId).toBe(retryCallId);
    const released = textOf(outputFor(toolOutputs, retry.toolCallId));
    expect(released).not.toContain("[appa] Blocked");
    expect(released).not.toContain("Tool output withheld");
    expect(released).not.toContain("The tool was not executed");

    expect(assistantText(events)).toContain(finalAnswer);
  } finally {
    for (const mappingId of wireMockMappingIds) {
      await request
        .delete(`${WIREMOCK_BASE_URL}/__admin/mappings/${mappingId}`)
        .catch(() => {});
    }
    if (conversationId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/chat/conversations/${conversationId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (agentId) await deleteAgent(request, agentId).catch(() => {});
    if (originalPolicy) {
      // Re-read the revision rather than reusing the one from the start: the
      // PUT above moved it, and a stale expectedRevision is refused.
      const current = await readPolicy(makeApiRequest, request).catch(
        () => undefined,
      );
      if (current) {
        await writePolicy(makeApiRequest, request, {
          content: originalPolicy.content,
          expectedRevision: current.revision,
        }).catch(() => {});
      }
    }
    if (deploymentWasEnabled === false) {
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: "/api/guardrails-deployment",
        data: { enabled: false },
      }).catch(() => {});
    }
  }
});

// === The scripted provider turns ===========================================

/**
 * The dispatch variant: the model reaches the same restricted tool through
 * `archestra__run_tool`, the way a `search_and_run_only` agent has to. The
 * policy names the target, so the denial, the remedy, and the restored
 * history must all carry the target's identity — never the wrapper's. The
 * released retry is still the wrapper Chat can execute.
 */
test("rules a run_tool dispatch by its target: notice names it, remedy clears it, wrapper retries", async ({
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(180_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const marker = `appa-dispatch-e2e-${suffix}`;
  const blockedCallId = `toolu_appa_${suffix}_blocked`;
  const remedyCallId = `toolu_appa_${suffix}_remedy`;
  const retryCallId = `toolu_appa_${suffix}_retry`;
  const finalAnswer = `OpenAPPA dispatch flow ${suffix} completed end to end.`;
  const dispatchInput = { tool_name: BLOCKED_TOOL, tool_args: {} };

  const wireMockMappingIds: string[] = [];
  let originalPolicy: GuardrailsPolicy | undefined;
  let deploymentWasEnabled: boolean | undefined;
  let agentId: string | undefined;
  let conversationId: string | undefined;

  try {
    const deploymentResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/guardrails-deployment",
    });
    const deployment = (await deploymentResponse.json()) as {
      enabled: boolean;
      featureEnabled: boolean;
    };
    expect(
      deployment.featureEnabled,
      "the stack was booted without ARCHESTRA_OPENAPPA_ENABLED=true — the openappa Playwright project requires it",
    ).toBe(true);
    deploymentWasEnabled = deployment.enabled;
    if (!deployment.enabled) {
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: "/api/guardrails-deployment",
        data: { enabled: true },
      });
    }

    originalPolicy = await readPolicy(makeApiRequest, request);
    await writePolicy(makeApiRequest, request, {
      content: TEST_POLICY,
      expectedRevision: originalPolicy.revision,
    });

    // The agent runs in the dispatch-only exposure mode, and the scripted
    // provider calls the restricted tool through run_tool — the path a
    // search_and_run_only agent must take for anything hidden.
    const agentResponse = await createAgent(
      request,
      `OpenAPPA dispatch flow ${suffix}`,
      "personal",
    );
    agentId = ((await agentResponse.json()) as { id: string }).id;
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agentId}`,
      data: { toolExposureMode: "search_and_run_only" },
    });

    const blockedToolId = await findToolId(
      makeApiRequest,
      request,
      BLOCKED_TOOL,
    );
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${agentId}/tools/${blockedToolId}`,
      data: {},
    });

    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agentId}`,
      data: { llmApiKeyId: apiKeyId, modelId: runtimeModel.dbId },
    });

    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat/agents/${agentId}/mcp-tools`,
    });
    const advertised = ((await toolsResponse.json()) as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(advertised).toEqual(
      expect.arrayContaining([NOTICE_TOOL, CONTROL_TOOL, DISPATCH_TOOL]),
    );

    for (const mapping of [
      proposeBlockedCallMapping({
        marker,
        blockedCallId,
        toolName: DISPATCH_TOOL,
        input: dispatchInput,
      }),
      executeRemedyMapping({ marker, blockedCallId, remedyCallId }),
      retryBlockedCallMapping({
        marker,
        remedyCallId,
        retryCallId,
        toolName: DISPATCH_TOOL,
        input: dispatchInput,
      }),
      finalAnswerMapping({ marker, retryCallId, finalAnswer }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    const conversationResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat/conversations",
      data: { agentId, modelId: runtimeModel.dbId, chatApiKeyId: apiKeyId },
    });
    const conversation = (await conversationResponse.json()) as { id: string };
    expect(conversation).toMatchObject({
      modelId: runtimeModel.dbId,
      chatApiKeyId: apiKeyId,
    });
    conversationId = conversation.id;

    const events = await runChatTurn(request, {
      conversationId,
      prompt:
        `${marker}: List the available skills by dispatching list_skills ` +
        "through run_tool. If the call is blocked, read the remedy plans you " +
        "are given, execute the offered plan with execute_remedy_plan using " +
        "its exact offer_id, and then retry the dispatch.",
    });

    const toolInputs = collect<ToolInput>(events, "tool-input-available");
    const toolOutputs = collect<ToolOutput>(events, "tool-output-available");

    // The denied dispatch reached the client as the notice — in the dispatch's
    // own position, under its own provider call id — but naming the TARGET.
    expect(toolInputs.map((call) => call.toolName)).toEqual([
      NOTICE_TOOL,
      CONTROL_TOOL,
      DISPATCH_TOOL,
    ]);

    const [notice, remedy, retry] = toolInputs;
    expect(notice.toolCallId).toBe(blockedCallId);
    const noticeInput = notice.input as {
      tool: string;
      arguments: unknown;
      ruling: string;
      notice: { v: number; call_id: string };
    };
    // The as-if-direct contract: the model reads the ruling against the tool
    // it asked for, with that tool's own arguments — the wrapper is transport.
    expect(noticeInput.tool).toBe(BLOCKED_TOOL);
    expect(asObject(noticeInput.arguments)).toEqual({});
    expect(noticeInput.ruling).toContain("[appa] Blocked");
    expect(noticeInput.notice).toEqual({ v: 1, call_id: blockedCallId });

    const ruling = textOf(outputFor(toolOutputs, notice.toolCallId));
    const offerId = readOfferId(ruling);
    expect((remedy.input as { offer_id: string }).offer_id).toBe(offerId);

    // The retry is released as the wrapper the client declared, with the
    // model's envelope arguments untouched — the client executes run_tool.
    expect(retry.toolCallId).toBe(retryCallId);
    expect(retry.input).toEqual(dispatchInput);
    const released = textOf(outputFor(toolOutputs, retry.toolCallId));
    expect(released).not.toContain("[appa] Blocked");
    expect(released).not.toContain("Tool output withheld");
    expect(released).not.toContain("The tool was not executed");

    expect(assistantText(events)).toContain(finalAnswer);
  } finally {
    for (const mappingId of wireMockMappingIds) {
      await request
        .delete(`${WIREMOCK_BASE_URL}/__admin/mappings/${mappingId}`)
        .catch(() => {});
    }
    if (conversationId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/chat/conversations/${conversationId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (agentId) await deleteAgent(request, agentId).catch(() => {});
    if (originalPolicy) {
      const current = await readPolicy(makeApiRequest, request).catch(
        () => undefined,
      );
      if (current) {
        await writePolicy(makeApiRequest, request, {
          content: originalPolicy.content,
          expectedRevision: current.revision,
        }).catch(() => {});
      }
    }
    if (deploymentWasEnabled === false) {
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: "/api/guardrails-deployment",
        data: { enabled: false },
      }).catch(() => {});
    }
  }
});

// === The scripted provider turns =============================================
//
// Four stubs on POST /anthropic/v1/messages, discriminated by which of this
// run's provider call ids the growing history already carries. Deliberately
// not WireMock scenarios: scenario state is global to the instance, and
// knowledge-permission-sync.spec.ts resets it.

function proposeBlockedCallMapping(params: {
  marker: string;
  blockedCallId: string;
  toolName?: string;
  input?: Record<string, unknown>;
}): Record<string, unknown> {
  return anthropicMapping({
    priority: 1,
    // The opening turn is the only one whose history has not yet been given
    // the first tool_use id. Nothing else is asserted here on purpose: a
    // second, weaker condition (say "no tool_result anywhere") could only
    // ever start matching some future tool description and silently drop
    // this stub.
    bodyPatterns: [{ contains: params.marker }, absent(params.blockedCallId)],
    events: toolUseEvents("msg_appa_root_propose", [
      {
        callId: params.blockedCallId,
        toolName: params.toolName ?? BLOCKED_TOOL,
        input: params.input ?? {},
      },
    ]),
  });
}

function executeRemedyMapping(params: {
  marker: string;
  blockedCallId: string;
  remedyCallId: string;
}): Record<string, unknown> {
  return anthropicMapping({
    priority: 2,
    bodyPatterns: [
      { contains: params.marker },
      { contains: params.blockedCallId },
      absent(params.remedyCallId),
    ],
    events: toolUseEvents("msg_appa_root_remedy", [
      {
        callId: params.remedyCallId,
        toolName: CONTROL_TOOL,
        input: { offer_id: OFFER_ID_PLACEHOLDER },
      },
    ]),
    templates: { [OFFER_ID_PLACEHOLDER]: OFFER_ID_TEMPLATE },
  });
}

function retryBlockedCallMapping(params: {
  marker: string;
  remedyCallId: string;
  retryCallId: string;
  toolName?: string;
  input?: Record<string, unknown>;
}): Record<string, unknown> {
  return anthropicMapping({
    priority: 3,
    bodyPatterns: [
      { contains: params.marker },
      { contains: params.remedyCallId },
      absent(params.retryCallId),
    ],
    events: toolUseEvents("msg_appa_root_retry", [
      {
        callId: params.retryCallId,
        toolName: params.toolName ?? BLOCKED_TOOL,
        input: params.input ?? {},
      },
    ]),
  });
}

function finalAnswerMapping(params: {
  marker: string;
  retryCallId: string;
  finalAnswer: string;
}): Record<string, unknown> {
  return anthropicMapping({
    priority: 4,
    bodyPatterns: [
      { contains: params.marker },
      { contains: params.retryCallId },
    ],
    events: textAnswerEvents("msg_appa_root_answer", params.finalAnswer),
  });
}
