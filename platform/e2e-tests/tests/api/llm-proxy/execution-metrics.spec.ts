import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";

test.describe("LLMProxy-ExecutionMetrics", () => {
  let agentId: string;

  test.afterEach(async ({ request, deleteAgent }) => {
    if (agentId) {
      await deleteAgent(request, agentId);
      agentId = "";
    }
  });

  test("stores execution id on interaction", async ({
    request,
    createLlmProxy,
    makeApiRequest,
    getInteractions,
  }) => {
    // 1. Create an LLM Proxy
    const createResponse = await createLlmProxy(
      request,
      "Execution Metrics Test",
    );
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Send an LLM proxy request with a unique execution ID
    const executionId = randomUUID();
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/openai/${agentId}/chat/completions`,
      headers: {
        Authorization: "Bearer openai-execution-metrics",
        "Content-Type": "application/json",
        "X-Archestra-Execution-Id": executionId,
      },
      data: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    expect(response.ok()).toBeTruthy();

    // 3. Verify the interaction was stored with the execution ID
    await expect
      .poll(
        async () => {
          const interactionsResponse = await getInteractions(request, {
            profileId: agentId,
          });
          const data = await interactionsResponse.json();
          return data.data;
        },
        { timeout: 10000, intervals: [500, 1000, 2000] },
      )
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ executionId })]),
      );
  });

  test("stores same execution id on both interactions when sent twice", async ({
    request,
    createLlmProxy,
    makeApiRequest,
    getInteractions,
  }) => {
    // 1. Create an LLM Proxy
    const createResponse = await createLlmProxy(
      request,
      "Execution Dedup Test",
    );
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Send two requests with the same execution ID
    const executionId = randomUUID();
    const sendRequest = () =>
      makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/v1/openai/${agentId}/chat/completions`,
        headers: {
          Authorization: "Bearer openai-execution-metrics",
          "Content-Type": "application/json",
          "X-Archestra-Execution-Id": executionId,
        },
        data: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

    const response1 = await sendRequest();
    expect(response1.ok()).toBeTruthy();

    const response2 = await sendRequest();
    expect(response2.ok()).toBeTruthy();

    // 3. Verify both interactions share the same execution ID
    await expect
      .poll(
        async () => {
          const interactionsResponse = await getInteractions(request, {
            profileId: agentId,
          });
          const data = await interactionsResponse.json();
          return data.data.filter(
            (i: { executionId: string | null }) =>
              i.executionId === executionId,
          );
        },
        { timeout: 10000, intervals: [500, 1000, 2000] },
      )
      .toHaveLength(2);
  });

  test("stores different execution ids separately", async ({
    request,
    createLlmProxy,
    makeApiRequest,
    getInteractions,
  }) => {
    // 1. Create an LLM Proxy
    const createResponse = await createLlmProxy(
      request,
      "Execution Separate Count Test",
    );
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Send two requests with different execution IDs
    const executionId1 = randomUUID();
    const executionId2 = randomUUID();

    const sendRequest = (execId: string) =>
      makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/v1/openai/${agentId}/chat/completions`,
        headers: {
          Authorization: "Bearer openai-execution-metrics",
          "Content-Type": "application/json",
          "X-Archestra-Execution-Id": execId,
        },
        data: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

    const response1 = await sendRequest(executionId1);
    expect(response1.ok()).toBeTruthy();

    const response2 = await sendRequest(executionId2);
    expect(response2.ok()).toBeTruthy();

    // 3. Verify two interactions with distinct execution IDs
    await expect
      .poll(
        async () => {
          const interactionsResponse = await getInteractions(request, {
            profileId: agentId,
          });
          const data = await interactionsResponse.json();
          const executionIds = new Set(
            data.data
              .map((i: { executionId: string | null }) => i.executionId)
              .filter(Boolean),
          );
          return executionIds.size;
        },
        { timeout: 10000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThanOrEqual(2);
  });
});
