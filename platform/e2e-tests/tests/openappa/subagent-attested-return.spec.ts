/**
 * A Chat agent delegates to its own subagent with a declared return schema,
 * end to end against the real stack. The only stubbed boundary is the
 * upstream Anthropic Messages API, served by WireMock.
 *
 * The parent's delegation call is a spawn: its return is declared on the
 * parent's behalf, the child runs on its own trajectory, and only a final
 * answer that matches the schema crosses back as the delegation's result.
 * A held answer goes back to the same child to revise; one that never
 * matches is withheld from the parent.
 *
 * Requires a stack booted with `ARCHESTRA_BETA=true` (the `openappa`
 * Playwright project).
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { WIREMOCK_BASE_URL } from "../../consts";
import { ensureWireMockAnthropicChatProvider } from "../../utils";
import { expect, test } from "../api-fixtures";
import {
  absent,
  addWireMockMapping,
  anthropicMapping,
  collect,
  findToolId,
  type GuardrailsPolicy,
  type MakeApiRequest,
  outputFor,
  readPolicy,
  runChatTurn,
  type ToolInput,
  type ToolOutput,
  textAnswerEvents,
  textOf,
  toolUseEvents,
  writePolicy,
} from "./helpers";

test.describe.configure({ mode: "serial" });

const READ_TOOL = "archestra__list_skills";
const CONTROL_TOOL = "archestra__execute_remedy_plan";

const testPolicy = (childTool: string) => `[policy]
version = 2

[[policy.sanitizer]]
name = "attest-schema"
on = ["tool_output"]

[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }

[policy.deployment]
context_control = true

[[policy.tool]]
name = "${childTool}"
delta = {}

# What the child reads here is untrusted.
[[policy.tool]]
name = "${READ_TOOL}"
delta = { trust = "suspicious" }
`;

/** Reads the live offer id out of the ruling in the request WireMock answers (see root-remedy-flow.spec.ts). */
const OFFER_ID_TEMPLATE =
  "{{regexExtract request.body '(?<=execute_remedy_plan[(]offer_id: ..)[0-9a-f]+'}}";
const OFFER_ID_PLACEHOLDER = "APPA_OFFER_ID_FROM_RULING";

const RETURN_SCHEMA = {
  type: "object",
  properties: { days: { type: "integer", minimum: 0, maximum: 365 } },
  required: ["days"],
};

/** The delegation result as a declared return, if that is what crossed. */
function attested(result: string): unknown {
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

/** The revision turn's own words, which only a held child's request carries. */
const REVISION_REQUEST = "Your final answer was not accepted";

/**
 * Matches the child request that follows `revisions` held answers. The last
 * scripted answer also covers every later revision.
 */
function revisionPatterns(
  revisions: number,
  last: boolean,
): Record<string, unknown>[] {
  const atLeast =
    revisions === 0
      ? []
      : [{ matches: `(?s)(.*${REVISION_REQUEST}){${revisions}}.*` }];
  if (last) return atLeast;
  return [
    ...atLeast,
    { doesNotMatch: `(?s)(.*${REVISION_REQUEST}){${revisions + 1}}.*` },
  ];
}

type ChildScope = { suffix: string; childOnly: Record<string, unknown>[] };

/** A child that answers with each of `answers` in turn; the last one repeats. */
function answers(...answers: string[]) {
  return ({ suffix, childOnly }: ChildScope) =>
    answers.map((answer, index) =>
      anthropicMapping({
        priority: 3,
        bodyPatterns: [
          ...childOnly,
          ...revisionPatterns(index, index === answers.length - 1),
        ],
        events: textAnswerEvents(`msg_${suffix}_child_${index}`, answer),
      }),
    );
}

type Stack = {
  apiKeyId: string;
  modelId: string;
  parentId: string;
  childTool: string;
};

let stack: Stack | undefined;
let originalPolicy: GuardrailsPolicy | undefined;
let deploymentWasEnabled: boolean | undefined;
const agentIds: string[] = [];

test.beforeAll(async ({ request, makeApiRequest, createAgent, syncModels }) => {
  const deployment = (await (
    await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/guardrails-deployment",
    })
  ).json()) as { enabled: boolean; featureEnabled: boolean };
  expect(
    deployment.featureEnabled,
    "the stack was booted without ARCHESTRA_BETA=true — the openappa Playwright project requires it",
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

  const { apiKeyId, runtimeModel } = await ensureWireMockAnthropicChatProvider({
    request,
    makeApiRequest,
    syncModels,
  });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const create = async (name: string, data: Record<string, unknown>) => {
    const id = (
      (await (await createAgent(request, name, "agent")).json()) as {
        id: string;
      }
    ).id;
    agentIds.push(id);
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${id}`,
      data: { llmApiKeyId: apiKeyId, modelId: runtimeModel.dbId, ...data },
    });
    return id;
  };
  const parentId = await create(`Attest parent ${suffix}`, {
    accessAllSubagents: true,
  });
  const childId = await create(`Attest reader ${suffix}`, {});
  const readToolId = await findToolId(makeApiRequest, request, READ_TOOL);
  await makeApiRequest({
    request,
    method: "post",
    urlSuffix: `/api/agents/${childId}/tools/${readToolId}`,
    data: {},
  });
  const childTool = `agent__attest_reader_${suffix}`;
  // A conversation keeps the policy it started with; every one here starts
  // after this.
  originalPolicy = await readPolicy(makeApiRequest, request);
  await writePolicy(makeApiRequest, request, {
    content: testPolicy(childTool),
    expectedRevision: originalPolicy.revision,
  });

  const tools = (await (
    await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat/agents/${parentId}/mcp-tools`,
    })
  ).json()) as { name: string; parameters: { properties?: object } | null }[];
  expect(
    tools.map((tool) => tool.name).filter((name) => name.startsWith("agent__")),
  ).toContain(childTool);
  expect(
    tools.find((tool) => tool.name === childTool)?.parameters?.properties,
    "the parent is offered its subagent with a declarable return",
  ).toHaveProperty("return_schema");

  stack = { apiKeyId, modelId: runtimeModel.dbId, parentId, childTool };
});

test.afterAll(async ({ request, makeApiRequest, deleteAgent }) => {
  for (const id of agentIds) await deleteAgent(request, id).catch(() => {});
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
});

/**
 * Scripts one delegation: the parent calls its subagent, the child runs
 * `childScript`, and the parent closes the turn. Parent and child requests are
 * told apart by the markers: only the parent's history carries the parent's
 * marker, so a child stub matches `childOnly`.
 */
async function delegate(
  {
    request,
    makeApiRequest,
  }: { request: APIRequestContext; makeApiRequest: MakeApiRequest },
  childScript: (child: ChildScope) => Record<string, unknown>[],
) {
  if (!stack) throw new Error("beforeAll did not set up the stack");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const parentMarker = `attest-parent-${suffix}`;
  const childMarker = `attest-child-${suffix}`;
  const delegateCallId = `toolu_attest_${suffix}_delegate`;
  const mappings = [
    anthropicMapping({
      priority: 1,
      bodyPatterns: [{ contains: parentMarker }, absent(delegateCallId)],
      events: toolUseEvents(`msg_${suffix}_delegate`, [
        {
          callId: delegateCallId,
          toolName: stack.childTool,
          input: {
            message: `${childMarker}: how many days are left on the lease?`,
            return_schema: RETURN_SCHEMA,
          },
        },
      ]),
    }),
    anthropicMapping({
      priority: 2,
      bodyPatterns: [{ contains: parentMarker }, { contains: delegateCallId }],
      events: textAnswerEvents(`msg_${suffix}_close`, `${suffix} closed.`),
    }),
    ...childScript({
      suffix,
      childOnly: [{ contains: childMarker }, absent(parentMarker)],
    }),
  ];
  const mappingIds: string[] = [];
  let conversationId: string | undefined;
  try {
    for (const mapping of mappings) {
      mappingIds.push(await addWireMockMapping(request, mapping));
    }
    conversationId = (
      (await (
        await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/chat/conversations",
          data: {
            agentId: stack.parentId,
            modelId: stack.modelId,
            chatApiKeyId: stack.apiKeyId,
          },
        })
      ).json()) as { id: string }
    ).id;
    const events = await runChatTurn(request, {
      conversationId,
      prompt: `${parentMarker}: ask the reader how many days are left.`,
    });
    const call = collect<ToolInput>(events, "tool-input-available").find(
      (input) => input.toolCallId === delegateCallId,
    );
    expect(call?.toolName).toBe(stack.childTool);
    const result = textOf(
      outputFor(
        collect<ToolOutput>(events, "tool-output-available"),
        delegateCallId,
      ),
    );
    const status = (await (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversationId}/openappa-status`,
      })
    ).json()) as { trust: string } | null;
    const childRequests = (
      (await (
        await request.post(`${WIREMOCK_BASE_URL}/__admin/requests/find`, {
          data: {
            method: "POST",
            urlPath: "/anthropic/v1/messages",
            bodyPatterns: [{ contains: childMarker }, absent(parentMarker)],
          },
        })
      ).json()) as { requests: unknown[] }
    ).requests.length;
    return { result, trust: status?.trust, childRequests };
  } finally {
    for (const id of mappingIds) {
      await request
        .delete(`${WIREMOCK_BASE_URL}/__admin/mappings/${id}`)
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
  }
}

test("a held answer is revised by the same child, and the matching one crosses at the parent's trust", async ({
  request,
  makeApiRequest,
}) => {
  test.setTimeout(180_000);
  const { result, trust, childRequests } = await delegate(
    { request, makeApiRequest },
    answers("There are about three days left on the lease.", '{"days":3}'),
  );

  expect(attested(result)).toEqual({ days: 3 });
  expect(trust).toBe("trusted");
  expect(childRequests).toBe(2);
});

test("an answer that never matches is withheld from the parent", async ({
  request,
  makeApiRequest,
}) => {
  test.setTimeout(180_000);
  const prose = "Roughly three days, give or take.";
  const { result, trust, childRequests } = await delegate(
    { request, makeApiRequest },
    answers(prose),
  );

  expect(attested(result), result).toBeUndefined();
  expect(result).not.toContain(prose);
  expect(trust).toBe("trusted");
  // The first answer and both revisions.
  expect(childRequests).toBe(3);
});

test("a child reads untrusted data, accepts the trust drop on its own trajectory, and its matching answer keeps the parent trusted", async ({
  request,
  makeApiRequest,
}) => {
  test.setTimeout(180_000);
  const { result, trust } = await delegate(
    { request, makeApiRequest },
    ({ suffix, childOnly }) => {
      const read = `toolu_attest_${suffix}_read`;
      const accept = `toolu_attest_${suffix}_accept`;
      const reread = `toolu_attest_${suffix}_reread`;
      const step = (
        priority: number,
        after: string | undefined,
        before: string,
        events: ReturnType<typeof textAnswerEvents>,
        templates?: Record<string, string>,
      ) =>
        anthropicMapping({
          priority,
          bodyPatterns: [
            ...childOnly,
            ...(after ? [{ contains: after }] : []),
            absent(before),
          ],
          events,
          templates,
        });
      return [
        step(
          4,
          undefined,
          read,
          toolUseEvents(`msg_${suffix}_read`, [
            { callId: read, toolName: READ_TOOL, input: {} },
          ]),
        ),
        step(
          5,
          read,
          accept,
          toolUseEvents(`msg_${suffix}_accept`, [
            {
              callId: accept,
              toolName: CONTROL_TOOL,
              input: { offer_id: OFFER_ID_PLACEHOLDER },
            },
          ]),
          { [OFFER_ID_PLACEHOLDER]: OFFER_ID_TEMPLATE },
        ),
        step(
          6,
          accept,
          reread,
          toolUseEvents(`msg_${suffix}_reread`, [
            { callId: reread, toolName: READ_TOOL, input: {} },
          ]),
        ),
        anthropicMapping({
          priority: 7,
          bodyPatterns: [...childOnly, { contains: reread }],
          events: textAnswerEvents(`msg_${suffix}_answer`, '{"days":3}'),
        }),
      ];
    },
  );

  expect(attested(result), result).toEqual({ days: 3 });
  expect(trust).toBe("trusted");
});
