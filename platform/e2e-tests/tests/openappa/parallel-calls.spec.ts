/**
 * OpenAPPA governance of parallel tool calls in Archestra Chat.
 *
 * This test suite covers scenarios where the LLM proposes multiple tool calls
 * in a single turn. All platform components run live: PostgreSQL, the OpenAPPA
 * native runtime, the MCP gateway, the LLM proxy, and the Chat agent loop.
 * WireMock stubs only the upstream Anthropic Messages API.
 *
 * The OpenAPPA runtime evaluates each call in a batch independently:
 * - Allowed calls pass through to the client unchanged.
 * - Denied calls become `archestra__get_remedy_plans` notice calls under their
 *   original call IDs. Each notice includes the original arguments and signed
 *   remedy offers.
 *
 * Test cases in this file:
 * 1. All allowed: Unrestricted calls pass through unchanged while the policy
 *    restricts other tools.
 * 2. Mixed: An allowed call runs immediately, while a denied call returns a notice.
 *    Executing the remedy clears the denial and releases the retried call.
 * 3. Multiple denials: Two denied calls return two notices with distinct offers.
 *    Executing both remedies releases both retried calls.
 * 4. Duplicate remedy: Executing a spent offer returns an error. The retried call
 *    releases only once.
 *
 * Policy settling:
 * The runtime recomposes policy rules asynchronously after updates. A conversation
 * uses the policy version active at creation time. Each test uses
 * `openSettledConversation` to verify that the runtime enforces the new policy
 * before running test assertions.
 *
 * Requirements:
 * The test stack must run with `ARCHESTRA_OPENAPPA_ENABLED=true`.
 * Run these tests through the `openappa` Playwright project.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
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
  type MakeApiRequest,
  outputFor,
  readOfferId,
  readPolicy,
  runChatTurn,
  type StreamEvent,
  type ToolInput,
  type ToolOutput,
  textAnswerEvents,
  textOf,
  toolUseEvents,
  writePolicy,
} from "./helpers";

// Every test modifies the deployment switch and shared policy.
// Run tests serially rather than in parallel.
test.describe.configure({ mode: "serial" });

const NOTICE_TOOL = "archestra__get_remedy_plans";
const CONTROL_TOOL = "archestra__execute_remedy_plan";
const BLOCKED_SKILLS = "archestra__list_skills";
const BLOCKED_WHOAMI = "archestra__whoami";
const ALLOWED_TEAMS = "archestra__list_teams";

/**
 * Extracts the first live `offer_id` from the WireMock request body.
 *
 * The runtime formats the remedy call as:
 * archestra__execute_remedy_plan(offer_id: "<hex-id>")
 *
 * Because this appears inside a JSON string, quotes are escaped as `\"`.
 * The regular expression uses a fixed-length lookbehind to match Java requirements.
 */
const FIRST_OFFER_TEMPLATE =
  "{{regexExtract request.body '(?<=execute_remedy_plan[(]offer_id: ..)[0-9a-f]+'}}";

/**
 * Extracts the second live `offer_id` from a request body with two rulings.
 *
 * WireMock captures the second offer ID in group 1. If a second offer does
 * not exist, the helper throws an error and WireMock returns status 500.
 */
const SECOND_OFFER_TEMPLATE =
  "{{regexExtract request.body 'execute_remedy_plan[(]offer_id: ..[0-9a-f]+.*?execute_remedy_plan[(]offer_id: ..([0-9a-f]+)' 'offers'}}{{offers.0}}";

/**
 * Placeholders for Handlebars templates inside the stub JSON.
 *
 * The test replaces these placeholders with Handlebars expressions after JSON
 * serialization. This prevents multiple layers of JSON escaping.
 */
const FIRST_OFFER_PLACEHOLDER = "APPA_FIRST_OFFER_FROM_RULING";
const SECOND_OFFER_PLACEHOLDER = "APPA_SECOND_OFFER_FROM_RULING";

/**
 * Creates a policy that blocks specified tools and allows specified tools.
 *
 * Blocked tools receive an audience restriction that requires an acceptance plan.
 * Allowed tools are listed explicitly to avoid relying on default policy behavior.
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

test("releases all calls unchanged when the policy allows the entire batch", async ({
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

    // Both calls reach the client unchanged without notice replacement.
    expect(toolInputs.map((call) => call.toolName)).toEqual([
      BLOCKED_WHOAMI,
      ALLOWED_TEAMS,
    ]);
    expect(toolInputs.map((call) => call.toolCallId)).toEqual([
      whoamiCallId,
      teamsCallId,
    ]);

    // Both calls execute. The whoami tool returns the agent name.
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

test("releases allowed call immediately, returns notice for denied call, and releases retried call after remedy", async ({
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

    // The allowed call in the mixed batch executed immediately without
    // waiting for a remedy.
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

test("evaluates two denied calls independently, emits two notices, and releases both retries after remedies", async ({
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

    // Verify that the model executed both distinct remedy offers.
    const spent = [
      (remedyOne.input as { offer_id: string }).offer_id,
      (remedyTwo.input as { offer_id: string }).offer_id,
    ].sort();
    expect(spent).toEqual([skillsOffer, whoamiOffer].sort());

    // Both remedies succeeded: neither output contains a ruling or error.
    for (const remedyId of [remedyOneId, remedyTwoId]) {
      const remedyOutput = textOf(outputFor(toolOutputs, remedyId));
      expect(remedyOutput).not.toContain("[appa] Blocked");
      expect(remedyOutput).not.toContain("No live offer");
    }

    // Both parallel retries were released and executed.
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

test("prevents duplicate remedy execution and releases retried call only once", async ({
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

    // The session handled the duplicate: the blocked tool ran exactly once.
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

type CreateAgent = (
  request: APIRequestContext,
  name: string,
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
 * Enables guardrails deployment, installs the test policy, and creates a test agent.
 *
 * Confirms that the gateway advertises both OpenAPPA notice and control tools.
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

  const agentResponse = await params.createAgent(request, params.agentName);
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

/** Creates a conversation configured to use the WireMock provider. */
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
 * Opens a conversation and confirms that the runtime enforces the new policy.
 *
 * The runtime updates policy rules asynchronously after a policy update.
 * A conversation uses the policy version active at conversation creation.
 * This helper tests the initial turn and verifies that observed tool calls
 * match the expected policy. If the policy has not settled yet, it deletes
 * the conversation and retries until the runtime applies the new policy.
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
 * Restores initial environment state. Removes WireMock mappings, the test
 * conversation, the test agent, and restores original policy settings.
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
