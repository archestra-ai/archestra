/**
 * A policy change reaches an open conversation at its next tool call.
 *
 * Every conversation decides its next call under its organization's current
 * policy revision. This spec opens a protected chat under a policy that
 * allows a tool, saves a policy that restricts it while the chat stays open,
 * and sends the next message in the same conversation: that call is denied
 * and becomes a notice. The chat's status rail and the Guardrails Effective
 * view then name the newer revision.
 *
 * All platform components run live; WireMock stubs only the upstream
 * Anthropic Messages API. A stack with one backend process cannot show a
 * publish by another pod; the native suite covers that case.
 *
 * This spec requires a stack booted with `ARCHESTRA_BETA=true` and lives in
 * the `openappa` Playwright project for that reason.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { WIREMOCK_BASE_URL } from "../../consts";
import { goToPage } from "../../fixtures";
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

const WHOAMI = "archestra__whoami";
const NOTICE_TOOL = "archestra__get_remedy_plans";

test("a policy saved while a chat is open decides that chat's next call", async ({
  page,
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(240_000);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const [before, after] = [
    `appa-live-before-${suffix}`,
    `appa-live-after-${suffix}`,
  ];
  const [firstCall, secondCall] = [
    `toolu_live_${suffix}_first`,
    `toolu_live_${suffix}_second`,
  ];
  const wireMockMappingIds: string[] = [];
  let agentId: string | undefined;
  let conversationId: string | undefined;
  let originalPolicy: GuardrailsPolicy | undefined;
  let deploymentWasEnabled: boolean | undefined;

  try {
    const deployment = (await (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/guardrails-deployment",
      })
    ).json()) as { enabled: boolean; featureEnabled: boolean };
    expect(
      deployment.featureEnabled,
      "the openappa Playwright project needs a stack booted with ARCHESTRA_BETA=true",
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
      content: policyFor({ restricted: false }),
      expectedRevision: originalPolicy.revision,
    });

    agentId = (
      (await (
        await createAgent(request, `OpenAPPA live revision ${suffix}`)
      ).json()) as { id: string }
    ).id;
    const toolId = await findToolId(makeApiRequest, request, WHOAMI);
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${agentId}/tools/${toolId}`,
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
      data: {
        llmApiKeyId: apiKeyId,
        modelId: runtimeModel.dbId,
        toolExposureMode: "full",
      },
    });

    // The second turn's request also carries the first turn's history, so its
    // mappings take precedence.
    for (const mapping of [
      anthropicMapping({
        priority: 1,
        bodyPatterns: [{ contains: after }, absent(secondCall)],
        events: toolUseEvents(`msg_live_${suffix}_after_propose`, [
          { callId: secondCall, toolName: WHOAMI, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 2,
        bodyPatterns: [{ contains: after }, { contains: secondCall }],
        events: textAnswerEvents(`msg_live_${suffix}_after_answer`, "done"),
      }),
      anthropicMapping({
        priority: 3,
        bodyPatterns: [{ contains: before }, absent(firstCall)],
        events: toolUseEvents(`msg_live_${suffix}_before_propose`, [
          { callId: firstCall, toolName: WHOAMI, input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 4,
        bodyPatterns: [{ contains: before }, { contains: firstCall }],
        events: textAnswerEvents(`msg_live_${suffix}_before_answer`, "done"),
      }),
    ]) {
      wireMockMappingIds.push(await addWireMockMapping(request, mapping));
    }

    conversationId = (
      (await (
        await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/chat/conversations",
          data: {
            agentId,
            modelId: runtimeModel.dbId,
            chatApiKeyId: apiKeyId,
          },
        })
      ).json()) as { id: string }
    ).id;

    const first = await runChatTurn(request, {
      conversationId,
      prompt: `${before}: call the whoami tool.`,
    });
    expect(
      collect<ToolInput>(first, "tool-input-available").map(
        (call) => call.toolName,
      ),
    ).toEqual([WHOAMI]);
    expect(
      textOf(
        outputFor(
          collect<ToolOutput>(first, "tool-output-available"),
          firstCall,
        ),
      ),
    ).toContain(suffix);
    const opened = await status(makeApiRequest, request, conversationId);

    // Saved while the conversation stays open.
    const saved = await readPolicy(makeApiRequest, request);
    await writePolicy(makeApiRequest, request, {
      content: policyFor({ restricted: true }),
      expectedRevision: saved.revision,
    });

    const second = await runChatTurn(request, {
      conversationId,
      prompt: `${after}: call the whoami tool again.`,
    });
    const denied = collect<ToolInput>(second, "tool-input-available");
    expect(
      denied.map((call) => [call.toolName, call.toolCallId]),
      "the open conversation's next call is decided under the saved policy",
    ).toEqual([[NOTICE_TOOL, secondCall]]);

    const followed = await status(makeApiRequest, request, conversationId);
    expect(followed.policyRevision).toBeGreaterThan(opened.policyRevision);

    await goToPage(page, `/chat/${conversationId}`);
    await expect(
      page.getByRole("status", {
        name: `policy revision: ${followed.policyRevision}`,
      }),
    ).toBeVisible();

    await goToPage(page, "/openappa/policy");
    await page.getByRole("tab", { name: "Effective" }).click();
    await expect(
      page.getByText(`Runtime revision ${followed.policyRevision} · published`),
    ).toBeVisible();
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

/**
 * A policy that declares whoami. Restricted, its result narrows the audience,
 * which the session must accept through a remedy: the call is denied.
 */
function policyFor(params: { restricted: boolean }): string {
  const delta = params.restricted
    ? '{ audience = ["lab@archestra.local"] }'
    : "{}";
  return `[policy]\nversion = 2\ntrust_chain = ["untrusted", "trusted"]\n\n[[policy.tool]]\nname = "${WHOAMI}"\ndelta = ${delta}\n`;
}

/** The conversation's OpenAPPA status, which names its policy revision. */
async function status(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  conversationId: string,
): Promise<{ policyRevision: number }> {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/chat/conversations/${conversationId}/openappa-status`,
  });
  const body = (await response.json()) as { policyRevision: number | null };
  expect(body?.policyRevision, "a protected chat names its revision").toEqual(
    expect.any(Number),
  );
  return { policyRevision: body.policyRevision as number };
}
