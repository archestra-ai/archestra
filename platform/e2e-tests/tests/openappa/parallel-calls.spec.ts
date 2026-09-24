/**
 * OpenAPPA governance of PARALLEL tool calls, end to end through Archestra
 * Chat against the real stack.
 *
 * `root-remedy-flow.spec.ts` covers the single-call root remedy flow; this
 * spec covers the matrix the runbook leaves manual: a provider turn that
 * proposes several tool calls at once. Everything is real — the platform
 * container, PostgreSQL, the OpenAPPA native runtime, the MCP gateway, the
 * LLM proxy and Chat's own agentic loop. The only stubbed boundary is the
 * upstream Anthropic Messages API, served by WireMock.
 *
 * The runtime rules on each call in a batch independently
 * (`appa-plugin-archestra/plugin.ts` `onToolCalls`): allowed siblings are
 * released as written, while each denied call is replaced — in its own
 * position, under its own provider call id — with an
 * `archestra__get_remedy_plans` notice whose arguments name the denied tool
 * and carry that denial's signed offers. The matrix:
 *
 *   1. All allowed: two unrestricted calls in one turn pass through
 *      untouched while a policy that restricts other tools is installed.
 *   2. Mixed: one denied, one allowed in the same turn — the allowed
 *      sibling executes while the denied one arrives as a notice, then the
 *      remedy clears the denial and the retry is released.
 *   3. Multiple denials: two denied calls in one turn produce two notices
 *      naming distinct offers; two remedy executions (one per offer) clear
 *      both, and both parallel retries are released.
 *   4. Duplicate remedy: re-executing an already-spent offer cannot
 *      release anything — the second execution is ruled unknown, and the
 *      single retry still releases exactly once.
 *
 * Interruption (aborting the stream mid-batch) is deliberately not in this
 * matrix: the server-side loop keeps no client-observable contract about
 * which in-flight executions land after an abort, so any assertion would
 * pin timing, not behavior.
 *
 * Policy settling: the runtime recomposes the enforced policy asynchronously
 * after a revision lands, and a conversation keeps the policy it started
 * with. Every test therefore opens its conversation through
 * `openSettledConversation`, which runs the scripted first turn and keeps the
 * conversation only when the observed governance matches the policy the test
 * installed — otherwise it deletes the conversation and probes a fresh one
 * until the runtime settles. Without this, the first test after a policy
 * change races the recomposition (observed on a retained stack: undeclared
 * tools refused under the previous policy while the new one allows them).
 *
 * This spec requires a stack booted with `ARCHESTRA_OPENAPPA_ENABLED=true`.
 * It lives in the `openappa` Playwright project for exactly that reason and
 * must never be added to another project's testMatch — see the note on
 * `testPatterns.openappa` in playwright.config.ts. The second switch —
 * deployment-wide, database-backed, off on a fresh stack — each test turns
 * on itself and restores afterwards.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { getE2eRequestUrl, UI_BASE_URL, WIREMOCK_BASE_URL } from "../../consts";
import { ensureWireMockAnthropicChatProvider } from "../../utils";
import { expect, test } from "../api-fixtures";

// Every test mutates the deployment-wide switch and the shared policy, so
// they cannot run beside each other under the project's fullyParallel default.
test.describe.configure({ mode: "serial" });

const NOTICE_TOOL = "archestra__get_remedy_plans";
const CONTROL_TOOL = "archestra__execute_remedy_plan";
const BLOCKED_SKILLS = "archestra__list_skills";
const BLOCKED_WHOAMI = "archestra__whoami";
const ALLOWED_TEAMS = "archestra__list_teams";

/**
 * Extracts the FIRST live `offer_id` from the ruling the runtime wrote, read
 * out of the request body WireMock is answering. Same mechanism as
 * `root-remedy-flow.spec.ts`: the ruling renders the remedy as
 *
 *     archestra__execute_remedy_plan(offer_id: "<16 lowercase hex chars>")
 *
 * and it reaches the provider inside a JSON string, so the quote arrives as
 * the two bytes `\"`. The lookbehind avoids backslashes (`[(]` for the paren,
 * `..` for the `\"` pair) and stays fixed-length, as Java's regex engine
 * requires.
 */
const FIRST_OFFER_TEMPLATE =
  "{{regexExtract request.body '(?<=execute_remedy_plan[(]offer_id: ..)[0-9a-f]+'}}";

/**
 * Extracts the SECOND live `offer_id` from a request body carrying two
 * rulings. `regexExtract` with a variable name assigns capture groups instead
 * of returning the whole match, so group 1 here is the second offer's id: the
 * first offer is consumed by the pattern's own prefix. The request body is a
 * single-line JSON document, so `.*?` reaches the second ruling wherever it
 * sits. When no second offer exists the helper throws and the stub 500s —
 * which is the correct, loud failure for a turn that expected two denials.
 */
const SECOND_OFFER_TEMPLATE =
  "{{regexExtract request.body 'execute_remedy_plan[(]offer_id: ..[0-9a-f]+.*?execute_remedy_plan[(]offer_id: ..([0-9a-f]+)' 'offers'}}{{offers.0}}";

/**
 * Stand-ins for the templates inside the stub's JSON, swapped for the real
 * Handlebars expressions after serialization — writing them straight into the
 * tool input would bury them under two rounds of JSON escaping (the SSE
 * event, then the `input_json_delta` payload), and WireMock renders the body
 * as plain text.
 */
const FIRST_OFFER_PLACEHOLDER = "APPA_FIRST_OFFER_FROM_RULING";
const SECOND_OFFER_PLACEHOLDER = "APPA_SECOND_OFFER_FROM_RULING";

/**
 * A policy that blocks each `blocked` tool by the same audience delta the
 * runbook uses (offering an acceptance plan per denial) and explicitly allows
 * each `allowed` tool. The allowed entries matter: a policy can refuse a tool
 * it does not name, so leaving the batch's unrestricted members undeclared
 * would make the tests depend on the default posture instead of pinning the
 * intended one. Deliberately no [externals] block: this flow needs no sidecar.
 */
function policyGoverning(params: {
  blocked: string[];
  allowed?: string[];
}): string {
  const entries = [
    ...(params.allowed ?? []).map(
      (tool) => `[[policy.tool]]\nname = "${tool}"\ndelta = {}`,
    ),
    ...params.blocked.map(
      (tool) =>
        `[[policy.tool]]\nname = "${tool}"\ndelta = { audience = ["lab@archestra.local"] }`,
    ),
  ].join("\n\n");
  return `[policy]\nversion = 2\ntrust_chain = ["untrusted", "trusted"]\n\n${entries}\n`;
}

type GuardrailsPolicy = { revision: number; content: string };
type StreamEvent = Record<string, unknown>;
type ToolInput = { toolCallId: string; toolName: string; input: unknown };
type ToolOutput = { toolCallId: string; output: unknown };

test("releases every call untouched when the policy allows the whole batch", async ({
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(300_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const marker = `appa-parallel-allowed-${suffix}`;
  const whoamiCallId = `toolu_par_${suffix}_who`;
  const teamsCallId = `toolu_par_${suffix}_teams`;
  const finalAnswer = `OpenAPPA parallel all-allowed flow ${suffix} completed.`;

  const wireMockMappingIds: string[] = [];
  let handle: StackHandle | undefined;
  let conversationId: string | undefined;

  try {
    handle = await setupGovernedChat({
      request,
      makeApiRequest,
      createAgent,
      syncModels,
      agentName: `OpenAPPA parallel allowed ${suffix}`,
      // The policy restricts a tool the model never calls: the batch under
      // test is entirely unrestricted, and explicitly so.
      policyContent: policyGoverning({
        blocked: [BLOCKED_SKILLS],
        allowed: [BLOCKED_WHOAMI, ALLOWED_TEAMS],
      }),
      toolNames: [BLOCKED_WHOAMI, ALLOWED_TEAMS],
    });

    for (const mapping of [
      anthropicMapping({
        priority: 1,
        bodyPatterns: [{ contains: marker }, absent(whoamiCallId)],
        events: toolUseEvents(`msg_par_${suffix}_propose`, [
          { callId: whoamiCallId, toolName: BLOCKED_WHOAMI, input: {} },
          { callId: teamsCallId, toolName: ALLOWED_TEAMS, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 2,
        bodyPatterns: [{ contains: marker }, { contains: whoamiCallId }],
        events: textAnswerEvents(`msg_par_${suffix}_answer`, finalAnswer),
      }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    const settled = await openSettledConversation({
      request,
      makeApiRequest,
      handle,
      prompt:
        `${marker}: In a single turn, call the whoami tool and the ` +
        "list_teams tool together, then tell me who I am.",
      settledWhen: (inputs) =>
        sameToolNames(inputs, [BLOCKED_WHOAMI, ALLOWED_TEAMS]),
    });
    conversationId = settled.conversationId;
    const events = settled.events;

    const toolInputs = collect<ToolInput>(events, "tool-input-available");
    const toolOutputs = collect<ToolOutput>(events, "tool-output-available");

    // Both calls reached the client exactly as the model wrote them — no
    // notice was injected and nothing was rewritten, even though APPa is
    // enforcing and a policy restricting another tool is installed.
    expect(toolInputs.map((call) => call.toolName)).toEqual([
      BLOCKED_WHOAMI,
      ALLOWED_TEAMS,
    ]);
    expect(toolInputs.map((call) => call.toolCallId)).toEqual([
      whoamiCallId,
      teamsCallId,
    ]);

    // Both executed for real: whoami answers with this agent's own name.
    const whoamiOutput = textOf(outputFor(toolOutputs, whoamiCallId));
    expect(whoamiOutput).toContain(suffix);
    const teamsOutput = textOf(outputFor(toolOutputs, teamsCallId));
    expect(teamsOutput).not.toContain("[appa]");
    expect(teamsOutput).not.toContain("Tool output withheld");

    expect(assistantText(events)).toContain(finalAnswer);
  } finally {
    await teardownGovernedChat({
      request,
      makeApiRequest,
      deleteAgent,
      handle,
      conversationId,
      wireMockMappingIds,
    });
  }
});

test("releases the allowed sibling while the denied call arrives as a notice, then releases the retry", async ({
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(300_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const marker = `appa-parallel-mixed-${suffix}`;
  const blockedCallId = `toolu_par_${suffix}_blocked`;
  const allowedCallId = `toolu_par_${suffix}_allowed`;
  const remedyCallId = `toolu_par_${suffix}_remedy`;
  const retryCallId = `toolu_par_${suffix}_retry`;
  const finalAnswer = `OpenAPPA parallel mixed flow ${suffix} completed.`;

  const wireMockMappingIds: string[] = [];
  let handle: StackHandle | undefined;
  let conversationId: string | undefined;

  try {
    handle = await setupGovernedChat({
      request,
      makeApiRequest,
      createAgent,
      syncModels,
      agentName: `OpenAPPA parallel mixed ${suffix}`,
      policyContent: policyGoverning({
        blocked: [BLOCKED_SKILLS],
        allowed: [ALLOWED_TEAMS],
      }),
      toolNames: [BLOCKED_SKILLS, ALLOWED_TEAMS],
    });

    for (const mapping of [
      anthropicMapping({
        priority: 1,
        bodyPatterns: [{ contains: marker }, absent(blockedCallId)],
        events: toolUseEvents(`msg_par_${suffix}_propose`, [
          { callId: blockedCallId, toolName: BLOCKED_SKILLS, input: {} },
          { callId: allowedCallId, toolName: ALLOWED_TEAMS, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 2,
        bodyPatterns: [
          { contains: marker },
          { contains: blockedCallId },
          absent(remedyCallId),
        ],
        events: toolUseEvents(`msg_par_${suffix}_remedy`, [
          {
            callId: remedyCallId,
            toolName: CONTROL_TOOL,
            input: { offer_id: FIRST_OFFER_PLACEHOLDER },
          },
        ]),
        templates: { [FIRST_OFFER_PLACEHOLDER]: FIRST_OFFER_TEMPLATE },
      }),
      anthropicMapping({
        priority: 3,
        bodyPatterns: [
          { contains: marker },
          { contains: remedyCallId },
          absent(retryCallId),
        ],
        events: toolUseEvents(`msg_par_${suffix}_retry`, [
          { callId: retryCallId, toolName: BLOCKED_SKILLS, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 4,
        bodyPatterns: [{ contains: marker }, { contains: retryCallId }],
        events: textAnswerEvents(`msg_par_${suffix}_answer`, finalAnswer),
      }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    const settled = await openSettledConversation({
      request,
      makeApiRequest,
      handle,
      prompt:
        `${marker}: In a single turn, call the list_skills tool and the ` +
        "list_teams tool together. If list_skills is blocked, read the " +
        "remedy plans you are given, execute the offered plan with " +
        "execute_remedy_plan using its exact offer_id, and then retry " +
        "list_skills.",
      settledWhen: (inputs) =>
        sameToolNames(inputs, [
          NOTICE_TOOL,
          ALLOWED_TEAMS,
          CONTROL_TOOL,
          BLOCKED_SKILLS,
        ]),
    });
    conversationId = settled.conversationId;
    const events = settled.events;

    const toolInputs = collect<ToolInput>(events, "tool-input-available");
    const toolOutputs = collect<ToolOutput>(events, "tool-output-available");

    // The denied call kept its position and its provider id but became the
    // notice; the allowed sibling beside it is untouched.
    expect(toolInputs.map((call) => call.toolName)).toEqual([
      NOTICE_TOOL,
      ALLOWED_TEAMS,
      CONTROL_TOOL,
      BLOCKED_SKILLS,
    ]);

    const [notice, allowed, remedy, retry] = toolInputs;
    expect(notice.toolCallId).toBe(blockedCallId);
    const noticeInput = notice.input as {
      tool: string;
      arguments: unknown;
      ruling: string;
      notice: { v: number; call_id: string };
    };
    expect(noticeInput.tool).toBe(BLOCKED_SKILLS);
    expect(asObject(noticeInput.arguments)).toEqual({});
    expect(noticeInput.ruling).toContain("[appa] Blocked");
    expect(noticeInput.notice).toEqual({ v: 1, call_id: blockedCallId });

    // The allowed sibling in the SAME denied batch executed for real — the
    // runtime did not hold or refuse it alongside its denied neighbour.
    expect(allowed.toolCallId).toBe(allowedCallId);
    const allowedOutput = textOf(outputFor(toolOutputs, allowedCallId));
    expect(allowedOutput).not.toContain("[appa] Blocked");
    expect(allowedOutput).not.toContain("Tool output withheld");
    expect(allowedOutput).not.toContain("The tool was not executed");

    const ruling = textOf(outputFor(toolOutputs, notice.toolCallId));
    const offerId = readOfferId(ruling);
    expect((remedy.input as { offer_id: string }).offer_id).toBe(offerId);

    expect(retry.toolCallId).toBe(retryCallId);
    const released = textOf(outputFor(toolOutputs, retry.toolCallId));
    expect(released).not.toContain("[appa] Blocked");
    expect(released).not.toContain("Tool output withheld");
    expect(released).not.toContain("The tool was not executed");

    expect(assistantText(events)).toContain(finalAnswer);
  } finally {
    await teardownGovernedChat({
      request,
      makeApiRequest,
      deleteAgent,
      handle,
      conversationId,
      wireMockMappingIds,
    });
  }
});

test("rules two denied calls independently: two notices, two offers spent in one turn, both retries released", async ({
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(360_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const marker = `appa-parallel-denials-${suffix}`;
  const skillsCallId = `toolu_par_${suffix}_skills`;
  const whoamiCallId = `toolu_par_${suffix}_whoami`;
  const remedyOneId = `toolu_par_${suffix}_remedy1`;
  const remedyTwoId = `toolu_par_${suffix}_remedy2`;
  const retrySkillsId = `toolu_par_${suffix}_retry1`;
  const retryWhoamiId = `toolu_par_${suffix}_retry2`;
  const finalAnswer = `OpenAPPA parallel multi-denial flow ${suffix} completed.`;

  const wireMockMappingIds: string[] = [];
  let handle: StackHandle | undefined;
  let conversationId: string | undefined;

  try {
    handle = await setupGovernedChat({
      request,
      makeApiRequest,
      createAgent,
      syncModels,
      agentName: `OpenAPPA parallel denials ${suffix}`,
      policyContent: policyGoverning({
        blocked: [BLOCKED_SKILLS, BLOCKED_WHOAMI],
      }),
      toolNames: [BLOCKED_SKILLS, BLOCKED_WHOAMI],
    });

    for (const mapping of [
      anthropicMapping({
        priority: 1,
        bodyPatterns: [{ contains: marker }, absent(skillsCallId)],
        events: toolUseEvents(`msg_par_${suffix}_propose`, [
          { callId: skillsCallId, toolName: BLOCKED_SKILLS, input: {} },
          { callId: whoamiCallId, toolName: BLOCKED_WHOAMI, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 2,
        bodyPatterns: [
          { contains: marker },
          { contains: skillsCallId },
          { contains: whoamiCallId },
          absent(remedyOneId),
        ],
        // One turn spending both offers. Which remedy call carries which
        // offer is indeterminate (the ids are minted at runtime), so the
        // assertions below compare them as a SET against the two rulings.
        events: toolUseEvents(`msg_par_${suffix}_remedies`, [
          {
            callId: remedyOneId,
            toolName: CONTROL_TOOL,
            input: { offer_id: FIRST_OFFER_PLACEHOLDER },
          },
          {
            callId: remedyTwoId,
            toolName: CONTROL_TOOL,
            input: { offer_id: SECOND_OFFER_PLACEHOLDER },
          },
        ]),
        templates: {
          [FIRST_OFFER_PLACEHOLDER]: FIRST_OFFER_TEMPLATE,
          [SECOND_OFFER_PLACEHOLDER]: SECOND_OFFER_TEMPLATE,
        },
      }),
      anthropicMapping({
        priority: 3,
        bodyPatterns: [
          { contains: marker },
          { contains: remedyOneId },
          absent(retrySkillsId),
        ],
        events: toolUseEvents(`msg_par_${suffix}_retries`, [
          { callId: retrySkillsId, toolName: BLOCKED_SKILLS, input: {} },
          { callId: retryWhoamiId, toolName: BLOCKED_WHOAMI, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 4,
        bodyPatterns: [{ contains: marker }, { contains: retrySkillsId }],
        events: textAnswerEvents(`msg_par_${suffix}_answer`, finalAnswer),
      }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    const settled = await openSettledConversation({
      request,
      makeApiRequest,
      handle,
      prompt:
        `${marker}: In a single turn, call the list_skills tool and the ` +
        "whoami tool together. Both will be blocked: read the remedy plans " +
        "you are given, execute each offered plan with execute_remedy_plan " +
        "using its exact offer_id, and then retry both tools together.",
      settledWhen: (inputs) =>
        sameToolNames(inputs, [
          NOTICE_TOOL,
          NOTICE_TOOL,
          CONTROL_TOOL,
          CONTROL_TOOL,
          BLOCKED_SKILLS,
          BLOCKED_WHOAMI,
        ]),
    });
    conversationId = settled.conversationId;
    const events = settled.events;

    const toolInputs = collect<ToolInput>(events, "tool-input-available");
    const toolOutputs = collect<ToolOutput>(events, "tool-output-available");

    // Each denied call became a notice in its own position under its own
    // provider id; the batch's denials did not collapse into one another.
    expect(toolInputs.map((call) => call.toolName)).toEqual([
      NOTICE_TOOL,
      NOTICE_TOOL,
      CONTROL_TOOL,
      CONTROL_TOOL,
      BLOCKED_SKILLS,
      BLOCKED_WHOAMI,
    ]);

    const [
      noticeSkills,
      noticeWhoami,
      remedyOne,
      remedyTwo,
      retrySkills,
      retryWhoami,
    ] = toolInputs;

    expect(noticeSkills.toolCallId).toBe(skillsCallId);
    const skillsNoticeInput = noticeSkills.input as {
      tool: string;
      ruling: string;
      notice: { v: number; call_id: string };
    };
    expect(skillsNoticeInput.tool).toBe(BLOCKED_SKILLS);
    expect(skillsNoticeInput.ruling).toContain("[appa] Blocked");
    expect(skillsNoticeInput.notice).toEqual({
      v: 1,
      call_id: skillsCallId,
    });

    expect(noticeWhoami.toolCallId).toBe(whoamiCallId);
    const whoamiNoticeInput = noticeWhoami.input as {
      tool: string;
      ruling: string;
      notice: { v: number; call_id: string };
    };
    expect(whoamiNoticeInput.tool).toBe(BLOCKED_WHOAMI);
    expect(whoamiNoticeInput.ruling).toContain("[appa] Blocked");
    expect(whoamiNoticeInput.notice).toEqual({
      v: 1,
      call_id: whoamiCallId,
    });

    // Each denial's ruling names its OWN offer — the two offers are distinct.
    const skillsOffer = readOfferId(
      textOf(outputFor(toolOutputs, skillsCallId)),
    );
    const whoamiOffer = readOfferId(
      textOf(outputFor(toolOutputs, whoamiCallId)),
    );
    expect(skillsOffer).not.toBe(whoamiOffer);

    // The model spent exactly those two offers — no more, no less. Set
    // comparison, because which scripted remedy call extracted which offer
    // from the request body is indeterminate.
    const spent = [
      (remedyOne.input as { offer_id: string }).offer_id,
      (remedyTwo.input as { offer_id: string }).offer_id,
    ].sort();
    expect(spent).toEqual([skillsOffer, whoamiOffer].sort());

    // Both remedies were authorized: neither output is a ruling.
    for (const remedyId of [remedyOneId, remedyTwoId]) {
      const remedyOutput = textOf(outputFor(toolOutputs, remedyId));
      expect(remedyOutput).not.toContain("[appa] Blocked");
      expect(remedyOutput).not.toContain("No live offer");
    }

    // Both parallel retries were released and executed for real.
    expect(retrySkills.toolCallId).toBe(retrySkillsId);
    expect(retryWhoami.toolCallId).toBe(retryWhoamiId);
    for (const retryId of [retrySkillsId, retryWhoamiId]) {
      const released = textOf(outputFor(toolOutputs, retryId));
      expect(released).not.toContain("[appa] Blocked");
      expect(released).not.toContain("Tool output withheld");
      expect(released).not.toContain("The tool was not executed");
    }

    expect(assistantText(events)).toContain(finalAnswer);
  } finally {
    await teardownGovernedChat({
      request,
      makeApiRequest,
      deleteAgent,
      handle,
      conversationId,
      wireMockMappingIds,
    });
  }
});

test("a spent offer cannot be executed twice: the duplicate is ruled unknown and the retry releases exactly once", async ({
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(300_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const marker = `appa-parallel-duplicate-${suffix}`;
  const blockedCallId = `toolu_par_${suffix}_blocked`;
  const remedyCallId = `toolu_par_${suffix}_remedy`;
  const duplicateCallId = `toolu_par_${suffix}_duplicate`;
  const retryCallId = `toolu_par_${suffix}_retry`;
  const finalAnswer = `OpenAPPA duplicate remedy flow ${suffix} completed.`;

  const wireMockMappingIds: string[] = [];
  let handle: StackHandle | undefined;
  let conversationId: string | undefined;

  try {
    handle = await setupGovernedChat({
      request,
      makeApiRequest,
      createAgent,
      syncModels,
      agentName: `OpenAPPA duplicate remedy ${suffix}`,
      policyContent: policyGoverning({ blocked: [BLOCKED_SKILLS] }),
      toolNames: [BLOCKED_SKILLS],
    });

    for (const mapping of [
      anthropicMapping({
        priority: 1,
        bodyPatterns: [{ contains: marker }, absent(blockedCallId)],
        events: toolUseEvents(`msg_par_${suffix}_propose`, [
          { callId: blockedCallId, toolName: BLOCKED_SKILLS, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 2,
        bodyPatterns: [
          { contains: marker },
          { contains: blockedCallId },
          absent(remedyCallId),
        ],
        events: toolUseEvents(`msg_par_${suffix}_remedy`, [
          {
            callId: remedyCallId,
            toolName: CONTROL_TOOL,
            input: { offer_id: FIRST_OFFER_PLACEHOLDER },
          },
        ]),
        templates: { [FIRST_OFFER_PLACEHOLDER]: FIRST_OFFER_TEMPLATE },
      }),
      anthropicMapping({
        priority: 3,
        bodyPatterns: [
          { contains: marker },
          { contains: remedyCallId },
          absent(duplicateCallId),
        ],
        // The retried call has not released yet, so the ruling — and with it
        // this same offer id — is still what the template finds first.
        events: toolUseEvents(`msg_par_${suffix}_duplicate`, [
          {
            callId: duplicateCallId,
            toolName: CONTROL_TOOL,
            input: { offer_id: FIRST_OFFER_PLACEHOLDER },
          },
        ]),
        templates: { [FIRST_OFFER_PLACEHOLDER]: FIRST_OFFER_TEMPLATE },
      }),
      anthropicMapping({
        priority: 4,
        bodyPatterns: [
          { contains: marker },
          { contains: duplicateCallId },
          absent(retryCallId),
        ],
        events: toolUseEvents(`msg_par_${suffix}_retry`, [
          { callId: retryCallId, toolName: BLOCKED_SKILLS, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 5,
        bodyPatterns: [{ contains: marker }, { contains: retryCallId }],
        events: textAnswerEvents(`msg_par_${suffix}_answer`, finalAnswer),
      }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    const settled = await openSettledConversation({
      request,
      makeApiRequest,
      handle,
      prompt:
        `${marker}: Call the list_skills tool. If it is blocked, read the ` +
        "remedy plans you are given, execute the offered plan with " +
        "execute_remedy_plan using its exact offer_id, then attempt that " +
        "same execution once more, and finally retry list_skills.",
      settledWhen: (inputs) =>
        sameToolNames(inputs, [
          NOTICE_TOOL,
          CONTROL_TOOL,
          CONTROL_TOOL,
          BLOCKED_SKILLS,
        ]),
    });
    conversationId = settled.conversationId;
    const events = settled.events;

    const toolInputs = collect<ToolInput>(events, "tool-input-available");
    const toolOutputs = collect<ToolOutput>(events, "tool-output-available");

    expect(toolInputs.map((call) => call.toolName)).toEqual([
      NOTICE_TOOL,
      CONTROL_TOOL,
      CONTROL_TOOL,
      BLOCKED_SKILLS,
    ]);

    const [notice, remedy, duplicate, retry] = toolInputs;
    expect(notice.toolCallId).toBe(blockedCallId);

    const ruling = textOf(outputFor(toolOutputs, notice.toolCallId));
    const offerId = readOfferId(ruling);

    // The first execution spent the ruling's offer...
    expect((remedy.input as { offer_id: string }).offer_id).toBe(offerId);
    const remedyOutput = textOf(outputFor(toolOutputs, remedy.toolCallId));
    expect(remedyOutput).not.toContain("[appa] Blocked");

    // ...and the duplicate named that SAME offer — the retry had not
    // released yet, so the ruling was still the only offer in play.
    expect((duplicate.input as { offer_id: string }).offer_id).toBe(offerId);

    // A spent offer releases nothing: the runtime rules it unknown instead
    // of executing the plan a second time.
    const duplicateOutput = textOf(
      outputFor(toolOutputs, duplicate.toolCallId),
    );
    expect(duplicateOutput).toContain("no live offer with this id exists");
    expect(duplicateOutput).not.toEqual(remedyOutput);

    // The session survived the duplicate: the blocked tool ran exactly once,
    // on the released retry.
    expect(retry.toolCallId).toBe(retryCallId);
    expect(
      toolInputs.filter((call) => call.toolName === BLOCKED_SKILLS),
    ).toHaveLength(1);
    const released = textOf(outputFor(toolOutputs, retry.toolCallId));
    expect(released).not.toContain("[appa] Blocked");
    expect(released).not.toContain("Tool output withheld");
    expect(released).not.toContain("The tool was not executed");

    expect(assistantText(events)).toContain(finalAnswer);
  } finally {
    await teardownGovernedChat({
      request,
      makeApiRequest,
      deleteAgent,
      handle,
      conversationId,
      wireMockMappingIds,
    });
  }
});

// === Stack setup and teardown ==============================================

/** Mirrors the `makeApiRequest` fixture's signature, as `utils/chat-ui.ts` does. */
type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  ignoreStatusCheck?: boolean;
}) => Promise<APIResponse>;

type CreateAgent = (
  request: APIRequestContext,
  name: string,
  scope: "personal" | "team" | "org",
) => Promise<APIResponse>;

type DeleteAgent = (
  request: APIRequestContext,
  agentId: string,
) => Promise<APIResponse>;

type SyncModels = (request: APIRequestContext) => Promise<APIResponse>;

type StackHandle = {
  agentId: string;
  apiKeyId: string;
  runtimeModelDbId: string;
  originalPolicy: GuardrailsPolicy;
  deploymentWasEnabled: boolean;
};

/**
 * Flips the deployment-wide switch on, installs the test policy (recording
 * the deployment's own for restore), and builds an agent carrying the named
 * tools on the WireMock-backed Anthropic provider. The APPA tool pair is
 * asserted advertised, which fails cheaply when the stack is not actually
 * enforcing.
 */
async function setupGovernedChat(params: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  createAgent: CreateAgent;
  syncModels: SyncModels;
  agentName: string;
  policyContent: string;
  toolNames: string[];
}): Promise<StackHandle> {
  const { request, makeApiRequest } = params;

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
  const deploymentWasEnabled = deployment.enabled;
  if (!deployment.enabled) {
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: "/api/guardrails-deployment",
      data: { enabled: true },
    });
  }

  const originalPolicy = await readPolicy(makeApiRequest, request);
  await writePolicy(makeApiRequest, request, {
    content: params.policyContent,
    expectedRevision: originalPolicy.revision,
  });

  const agentResponse = await params.createAgent(
    request,
    params.agentName,
    "personal",
  );
  const agentId = ((await agentResponse.json()) as { id: string }).id;
  for (const toolName of params.toolNames) {
    const toolId = await findToolId(makeApiRequest, request, toolName);
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${agentId}/tools/${toolId}`,
      data: {},
    });
  }

  const { apiKeyId, runtimeModel } = await ensureWireMockAnthropicChatProvider({
    request,
    makeApiRequest,
    syncModels: params.syncModels,
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
  expect(
    advertised,
    "the gateway advertises both APPA tools only while OpenAPPA enforces — the feature flag and the deployment switch are both on by this point",
  ).toEqual(expect.arrayContaining([NOTICE_TOOL, CONTROL_TOOL]));
  for (const toolName of params.toolNames) {
    expect(advertised).toContain(toolName);
  }

  return {
    agentId,
    apiKeyId,
    runtimeModelDbId: runtimeModel.dbId,
    originalPolicy,
    deploymentWasEnabled,
  };
}

/** Creates a conversation pinned to the WireMock provider, after the policy is installed. */
async function openConversation(params: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  handle: StackHandle;
}): Promise<string> {
  const { request, makeApiRequest, handle } = params;
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/chat/conversations",
    // An explicit selection keeps saved member preferences from routing this
    // fixture to a real provider instead of WireMock on retained stacks.
    data: {
      agentId: handle.agentId,
      modelId: handle.runtimeModelDbId,
      chatApiKeyId: handle.apiKeyId,
    },
  });
  const conversation = (await response.json()) as { id: string };
  expect(conversation).toMatchObject({
    modelId: handle.runtimeModelDbId,
    chatApiKeyId: handle.apiKeyId,
  });
  return conversation.id;
}

/**
 * Opens a conversation whose first turn PROVES the runtime is enforcing the
 * policy the test just installed, and returns that conversation's full event
 * stream.
 *
 * The runtime recomposes the enforced policy asynchronously after a revision
 * lands, and a conversation keeps the policy it started with — a conversation
 * opened inside the recomposition gap is governed by the previous policy for
 * its whole life. There is no REST read of the composed policy, so the only
 * honest probe is a governed turn: open a conversation, run the scripted
 * turn, and keep the conversation only when the observed tool sequence
 * matches the installed policy. On a mismatch (or a stream error, which is
 * how an unservable scripted turn surfaces) the conversation is deleted and a
 * fresh one is probed after a short wait; the runtime settles within a few
 * attempts.
 */
async function openSettledConversation(params: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  handle: StackHandle;
  prompt: string;
  settledWhen: (toolInputs: ToolInput[]) => boolean;
}): Promise<{ conversationId: string; events: StreamEvent[] }> {
  const { request, makeApiRequest, handle } = params;
  let lastFailure: unknown = new Error("the policy never settled");
  for (let attempt = 0; attempt < 8; attempt++) {
    let conversationId: string | undefined;
    try {
      conversationId = await openConversation({
        request,
        makeApiRequest,
        handle,
      });
      const events = await runChatTurn(request, {
        conversationId,
        prompt: params.prompt,
      });
      const toolInputs = collect<ToolInput>(events, "tool-input-available");
      if (params.settledWhen(toolInputs)) {
        return { conversationId, events };
      }
      lastFailure = new Error(
        `turn one was governed by a different policy: [${toolInputs
          .map((call) => call.toolName)
          .join(", ")}]`,
      );
    } catch (error) {
      lastFailure = error;
    }
    if (conversationId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/chat/conversations/${conversationId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw lastFailure;
}

function sameToolNames(inputs: ToolInput[], expected: string[]): boolean {
  return (
    inputs.length === expected.length &&
    inputs.every((call, index) => call.toolName === expected[index])
  );
}

/**
 * Best-effort restore: WireMock mappings, the conversation, the agent, the
 * deployment's own policy, and the deployment switch if this test flipped it.
 */
async function teardownGovernedChat(params: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  deleteAgent: DeleteAgent;
  handle: StackHandle | undefined;
  conversationId: string | undefined;
  wireMockMappingIds: string[];
}): Promise<void> {
  const { request, makeApiRequest } = params;
  for (const mappingId of params.wireMockMappingIds) {
    await request
      .delete(`${WIREMOCK_BASE_URL}/__admin/mappings/${mappingId}`)
      .catch(() => {});
  }
  if (params.conversationId) {
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat/conversations/${params.conversationId}`,
      ignoreStatusCheck: true,
    }).catch(() => {});
  }
  if (params.handle?.agentId) {
    await params.deleteAgent(request, params.handle.agentId).catch(() => {});
  }
  if (params.handle?.originalPolicy) {
    // Re-read the revision rather than reusing the one from the start: the
    // PUT above moved it, and a stale expectedRevision is refused.
    const current = await readPolicy(makeApiRequest, request).catch(
      () => undefined,
    );
    if (current) {
      await writePolicy(makeApiRequest, request, {
        content: params.handle.originalPolicy.content,
        expectedRevision: current.revision,
      }).catch(() => {});
    }
  }
  if (params.handle && params.handle.deploymentWasEnabled === false) {
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: "/api/guardrails-deployment",
      data: { enabled: false },
    }).catch(() => {});
  }
}

// === The scripted provider turns ===========================================
//
// Stubs on POST /anthropic/v1/messages, discriminated by which of this run's
// provider call ids the growing history already carries. Deliberately not
// WireMock scenarios: scenario state is global to the instance, and
// knowledge-permission-sync.spec.ts resets it.

type SseEvent = { event: string; data: Record<string, unknown> };

function anthropicMapping(params: {
  priority: number;
  bodyPatterns: Record<string, unknown>[];
  events: SseEvent[];
  templates?: Record<string, string>;
}): Record<string, unknown> {
  let body = anthropicSse(params.events);
  for (const [placeholder, expression] of Object.entries(
    params.templates ?? {},
  )) {
    body = body.split(placeholder).join(expression);
  }
  const templated = params.templates !== undefined;
  return {
    priority: params.priority,
    request: {
      method: "POST",
      urlPath: "/anthropic/v1/messages",
      bodyPatterns: params.bodyPatterns,
    },
    response: {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      ...(templated ? { transformers: ["response-template"] } : {}),
      body,
    },
  };
}

/** Negative body match. `(?s)` so a body carrying a newline still matches. */
function absent(needle: string): Record<string, unknown> {
  return { doesNotMatch: `(?s).*${needle}.*` };
}

/** One assistant message proposing `calls.length` tool calls, one content block each. */
function toolUseEvents(
  messageId: string,
  calls: Array<{
    callId: string;
    toolName: string;
    input: Record<string, unknown>;
  }>,
): SseEvent[] {
  const events: SseEvent[] = [messageStart(messageId)];
  calls.forEach((call, index) => {
    events.push(
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: call.callId,
            name: call.toolName,
            input: {},
          },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(call.input),
          },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index },
      },
    );
  });
  events.push(messageDelta("tool_use"), {
    event: "message_stop",
    data: { type: "message_stop" },
  });
  return events;
}

function textAnswerEvents(messageId: string, text: string): SseEvent[] {
  return [
    messageStart(messageId),
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    messageDelta("end_turn"),
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function messageStart(id: string): SseEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet-20241022",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
  };
}

function messageDelta(stopReason: string): SseEvent {
  return {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 15 },
    },
  };
}

function anthropicSse(events: SseEvent[]): string {
  return events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

async function addWireMockMapping(
  request: APIRequestContext,
  mapping: Record<string, unknown>,
): Promise<string> {
  const response = await request.post(`${WIREMOCK_BASE_URL}/__admin/mappings`, {
    data: mapping,
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

// === Policy, tool, and stream plumbing ======================================

async function readPolicy(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
): Promise<GuardrailsPolicy> {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/guardrails-policy",
  });
  return (await response.json()) as GuardrailsPolicy;
}

async function writePolicy(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  data: { content: string; expectedRevision: number },
): Promise<void> {
  await makeApiRequest({
    request,
    method: "put",
    urlSuffix: "/api/guardrails-policy",
    data,
  });
}

async function findToolId(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/tools/with-assignments?search=${encodeURIComponent(name)}`,
  });
  const { data } = (await response.json()) as {
    data: { id: string; name: string }[];
  };
  const tool = data.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} is not registered on this stack`);
  return tool.id;
}

/**
 * Posts one user turn and returns every chunk of the UI message stream.
 *
 * Chat runs the agentic loop server-side, so this single request spans all
 * scripted provider turns and the tool executions between them.
 */
async function runChatTurn(
  request: APIRequestContext,
  params: { conversationId: string; prompt: string },
): Promise<StreamEvent[]> {
  const response = await request.post(getE2eRequestUrl("/api/chat"), {
    headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
    timeout: 120_000,
    data: {
      id: params.conversationId,
      trigger: "submit-message",
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: params.prompt }],
        },
      ],
    },
  });
  const raw = await response.text();
  expect(response.ok(), `chat stream failed: ${response.status()} ${raw}`).toBe(
    true,
  );
  const events = parseUiMessageStream(raw);
  const errors = events.filter((event) => event.type === "error");
  expect(
    errors,
    `chat stream reported an error: ${JSON.stringify(errors)}`,
  ).toEqual([]);
  return events;
}

function parseUiMessageStream(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as StreamEvent);
    } catch {
      // Keep-alives and other non-JSON frames are not part of the contract.
    }
  }
  return events;
}

function collect<T>(events: StreamEvent[], type: string): T[] {
  return events.filter((event) => event.type === type) as T[];
}

function outputFor(outputs: ToolOutput[], toolCallId: string): unknown {
  const match = outputs.find((output) => output.toolCallId === toolCallId);
  if (match === undefined)
    throw new Error(`No tool output was streamed for ${toolCallId}`);
  return match.output;
}

/** A tool result reaches the stream as text or as MCP content blocks. */
function textOf(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function asObject(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * The offer the ruling names.
 *
 * Tolerant of the two shapes the ruling can arrive in on this side: raw text,
 * or re-serialized MCP content blocks where the quotes carry backslashes.
 */
function readOfferId(ruling: string): string {
  const match = /execute_remedy_plan\(offer_id:\s*\\*"([0-9a-f]+)/.exec(ruling);
  if (!match)
    throw new Error(`The ruling named no offer_id:\n${ruling.slice(0, 2000)}`);
  return match[1];
}

function assistantText(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === "text-delta")
    .map((event) => String(event.delta ?? event.text ?? ""))
    .join("");
}
