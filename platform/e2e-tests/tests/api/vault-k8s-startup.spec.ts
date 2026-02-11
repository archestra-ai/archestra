import { expect, test } from "./fixtures";

test.describe("Vault K8s startup - DB URL from Vault", () => {
  test("health endpoint is accessible", async ({ request, makeApiRequest }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/health",
      ignoreStatusCheck: true,
    });
    expect(response.ok()).toBeTruthy();
  });

  test("can create and delete an agent (proves DB + migrations work)", async ({
    request,
    createAgent,
    deleteAgent,
  }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const agentName = `vault-k8s-test-agent-${uniqueSuffix}`;

    const createResponse = await createAgent(request, agentName);
    const agent = await createResponse.json();

    expect(agent).toHaveProperty("id");
    expect(agent.name).toBe(agentName);

    // Cleanup
    await deleteAgent(request, agent.id);
  });

  test("vault init container injected dummy env var", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/test",
      ignoreStatusCheck: true,
    });
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.value).toBe("hello-from-vault");
  });
});
