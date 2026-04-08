import { API_BASE_URL } from "../../../consts";
import { expect, test } from "../fixtures";

test.describe.configure({ mode: "serial" });

test.describe("Azure responses proxy", () => {
  test.beforeEach(async ({ request, clearWiremockRequests }) => {
    await clearWiremockRequests(request);
  });

  test("proxies non-streaming Azure responses requests", async ({
    request,
    createLlmProxy,
    deleteAgent,
    getInteractions,
    getWiremockRequests,
  }) => {
    const createResponse = await createLlmProxy(
      request,
      "Azure Responses Proxy",
      "org",
    );
    const agent = await createResponse.json();

    try {
      const response = await request.post(
        `${API_BASE_URL}/v1/azure/${agent.id}/responses`,
        {
          headers: {
            Authorization: "Bearer azure-responses-nonstream",
            "Content-Type": "application/json",
          },
          data: {
            model: "gpt-4.1",
            input: "azure-responses-nonstream",
          },
        },
      );

      expect(response.ok()).toBeTruthy();

      const body = await response.json();
      expect(body.object).toBe("response");
      expect(body.output[0].content[0].text).toBe(
        "This is a mocked Azure Responses reply.",
      );

      const wiremockRequests = await getWiremockRequests(request, {
        method: "POST",
        urlPattern: "/azure/openai/responses",
      });
      expect(wiremockRequests).toHaveLength(1);

      const interactionsResponse = await getInteractions(request, {
        profileId: agent.id,
      });
      const interactions = (await interactionsResponse.json()).data;
      expect(
        interactions.some(
          (interaction: { type: string }) =>
            interaction.type === "azure:responses",
        ),
      ).toBeTruthy();
    } finally {
      await deleteAgent(request, agent.id);
    }
  });

  test("streams Azure responses events through the proxy", async ({
    request,
    createLlmProxy,
    deleteAgent,
  }) => {
    const createResponse = await createLlmProxy(
      request,
      "Azure Responses Stream Proxy",
      "org",
    );
    const agent = await createResponse.json();

    try {
      const response = await request.post(
        `${API_BASE_URL}/v1/azure/${agent.id}/responses`,
        {
          headers: {
            Authorization: "Bearer azure-responses-stream",
            "Content-Type": "application/json",
          },
          data: {
            model: "gpt-4.1",
            input: "azure-responses-stream",
            stream: true,
          },
        },
      );

      expect(response.ok()).toBeTruthy();

      const body = await response.text();
      expect(body).toContain('"type":"response.output_text.delta"');
      expect(body).toContain('"type":"response.completed"');
      expect(body).toContain("data: [DONE]");
    } finally {
      await deleteAgent(request, agent.id);
    }
  });
});
