import { randomUUID } from "node:crypto";
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
  readPolicy,
  runChatTurn,
  type ToolInput,
  textAnswerEvents,
  toolUseEvents,
  writePolicy,
} from "./helpers";

test("snapshot sessions keep their opening policy while live sessions resume following", async ({
  page,
  request,
  makeApiRequest,
  createAgent,
  deleteAgent,
  syncModels,
}) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().replaceAll("-", "");
  const conversations: string[] = [];
  const mappings: string[] = [];
  let originalPolicy: GuardrailsPolicy | undefined;
  let originalDeployment:
    | { enabled: boolean; newSessionPolicy: "live" | "snapshot" }
    | undefined;
  let agentId: string | undefined;
  const setMode = (newSessionPolicy: "live" | "snapshot") =>
    makeApiRequest({
      request,
      method: "put",
      urlSuffix: "/api/guardrails-deployment",
      data: { enabled: true, newSessionPolicy },
    });
  const status = async (conversationId: string) =>
    (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversationId}/openappa-status`,
      })
    ).json() as Promise<{
      policyRevision: number | null;
      newSessionPolicy: "live" | "snapshot";
    }>;
  const turn = async (params: {
    conversationId: string;
    step: number;
    allowed: boolean;
  }) => {
    const prompt = `snapshot-${suffix}-${params.step}`;
    const callId = `toolu_snapshot_${suffix}_${params.step}`;
    for (const mapping of [
      anthropicMapping({
        priority: 20 - params.step * 2,
        bodyPatterns: [{ contains: prompt }, absent(callId)],
        events: toolUseEvents(`msg_${callId}_call`, [
          { callId, toolName: "archestra__whoami", input: {} },
        ]),
      }),
      anthropicMapping({
        priority: 21 - params.step * 2,
        bodyPatterns: [{ contains: prompt }, { contains: callId }],
        events: textAnswerEvents(`msg_${callId}_answer`, "done"),
      }),
    ]) {
      mappings.push(await addWireMockMapping(request, mapping));
    }
    const events = await runChatTurn(request, {
      conversationId: params.conversationId,
      prompt: `${prompt}: call the whoami tool.`,
    });
    expect(
      collect<ToolInput>(events, "tool-input-available").map(
        (input) => input.toolName,
      ),
    ).toEqual([
      params.allowed ? "archestra__whoami" : "archestra__get_remedy_plans",
    ]);
  };

  try {
    const deployment = await (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/guardrails-deployment",
      })
    ).json();
    expect(deployment.featureEnabled).toBe(true);
    originalDeployment = {
      enabled: deployment.enabled,
      newSessionPolicy: deployment.newSessionPolicy,
    };
    originalPolicy = await readPolicy(makeApiRequest, request);
    await setMode("live");
    await writePolicy(makeApiRequest, request, {
      content: policy(false),
      expectedRevision: originalPolicy.revision,
    });
    agentId = (
      await (await createAgent(request, `Snapshot policy ${suffix}`)).json()
    ).id;
    const toolId = await findToolId(
      makeApiRequest,
      request,
      "archestra__whoami",
    );
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
    const createConversation = async () => {
      const conversation = await (
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
      ).json();
      conversations.push(conversation.id);
      return conversation.id as string;
    };
    const following = await createConversation();
    await turn({ conversationId: following, step: 0, allowed: true });
    const opened = await status(following);
    expect(opened.policyRevision).toEqual(expect.any(Number));

    await setMode("snapshot");
    const pinned = await createConversation();
    await turn({ conversationId: pinned, step: 1, allowed: true });
    const saved = await readPolicy(makeApiRequest, request);
    await writePolicy(makeApiRequest, request, {
      content: policy(true),
      expectedRevision: saved.revision,
    });
    await turn({ conversationId: following, step: 2, allowed: true });
    await turn({ conversationId: pinned, step: 3, allowed: true });
    expect(await status(following)).toMatchObject({
      policyRevision: opened.policyRevision,
      newSessionPolicy: "snapshot",
    });
    expect(await status(pinned)).toMatchObject({
      policyRevision: null,
      newSessionPolicy: "snapshot",
    });
    await goToPage(page, `/chat/${pinned}`);
    await expect(
      page.getByRole("status", { name: "policy snapshot" }),
    ).toBeVisible();

    const laterSnapshot = await createConversation();
    await turn({ conversationId: laterSnapshot, step: 4, allowed: false });
    await setMode("live");
    await turn({ conversationId: following, step: 5, allowed: false });
    await turn({ conversationId: pinned, step: 6, allowed: true });
    expect((await status(following)).policyRevision).toBeGreaterThan(
      opened.policyRevision as number,
    );
    expect((await status(pinned)).policyRevision).toBeNull();
    await goToPage(page, `/chat/${pinned}`);
    await expect(
      page.getByRole("status", { name: "policy snapshot" }),
    ).toBeVisible();
  } finally {
    for (const mapping of mappings) {
      await request
        .delete(`${WIREMOCK_BASE_URL}/__admin/mappings/${mapping}`)
        .catch(() => {});
    }
    for (const conversationId of conversations) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/chat/conversations/${conversationId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (agentId) await deleteAgent(request, agentId).catch(() => {});
    if (originalPolicy) {
      const current = await readPolicy(makeApiRequest, request);
      await writePolicy(makeApiRequest, request, {
        content: originalPolicy.content,
        expectedRevision: current.revision,
      });
    }
    if (originalDeployment) {
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: "/api/guardrails-deployment",
        data: originalDeployment,
      });
    }
  }
});

function policy(restricted: boolean): string {
  const delta = restricted ? '{ audience = ["lab@archestra.local"] }' : "{}";
  return `[policy]\nversion = 2\ntrust_chain = ["untrusted", "trusted"]\n[[policy.tool]]\nname = "archestra__whoami"\ndelta = ${delta}\n`;
}
