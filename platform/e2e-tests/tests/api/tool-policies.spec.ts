import { expect, test } from "./fixtures";

test.describe("Tool Policies API", () => {
  test("should list, create, update, and delete tool policies", async ({
    request,
    makeApiRequest,
  }) => {
    // 1) Fetch a tool to target
    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/tools?limit=25",
    });
    const toolsPayload = await toolsResponse.json();

    expect(toolsPayload?.data?.length).toBeGreaterThan(0);

    const toolId: string = toolsPayload.data[0].id;

    // 2) Create a policy for the tool
    const policyName = `e2e-policy-${Date.now()}`;
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/tools/${toolId}/policies`,
      data: {
        name: policyName,
        allowUsageWhenUntrustedDataIsPresent: false,
        toolResultTreatment: "untrusted",
        responseModifierTemplate: null,
      },
    });
    const createdPolicy = await createResponse.json();

    expect(createdPolicy.id).toBeDefined();
    expect(createdPolicy.toolId).toBe(toolId);
    expect(createdPolicy.name).toBe(policyName);

    // 3) List policies for the tool and ensure the new one is present
    const listResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/tools/${toolId}/policies`,
    });
    const policies = await listResponse.json();

    const found = policies.find(
      (policy: { id: string }) => policy.id === createdPolicy.id,
    );
    expect(found).toBeTruthy();

    // 4) Update the policy
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/tool-policies/${createdPolicy.id}`,
      data: {
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "trusted",
      },
    });
    const updatedPolicy = await updateResponse.json();

    expect(updatedPolicy.allowUsageWhenUntrustedDataIsPresent).toBe(true);
    expect(updatedPolicy.toolResultTreatment).toBe("trusted");

    // 5) Delete the policy
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/tool-policies/${createdPolicy.id}`,
    });
    const deletePayload = await deleteResponse.json();

    expect(deletePayload.success).toBe(true);
  });
});
