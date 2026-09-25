import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent } from "../src/mocks/data/agents";
import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeCatalogItem } from "../src/mocks/data/catalog";
import { expect, test } from "./fixtures";

const gateway = makeAgent({
  id: "test-gateway-environment",
  name: "Environment reproduction",
  scope: "org",
  agentType: "mcp_gateway",
  environmentId: "10000000-0000-4000-8000-000000000001",
});

test("opening and saving a gateway preserves its saved restricted environment", async ({
  page,
  mswControl,
}, testInfo) => {
  await mswControl.use({
    method: "get",
    url: `/api/agents/${gateway.id}`,
    body: gateway,
  });
  await mswControl.use({
    method: "get",
    url: "/api/user/permissions",
    body: makeUserPermissions({
      mcpGateway: ["read", "create", "update", "delete"],
    }),
  });
  await mswControl.use({
    method: "get",
    url: "/api/environments",
    body: {
      environments: [
        {
          id: gateway.environmentId,
          name: "Restricted test environment",
          restricted: true,
          description: null,
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          name: "Other environment",
          restricted: false,
          description: null,
        },
      ],
      defaultAssignedCatalogCount: 0,
      resourceDefaults: {
        agent: null,
        app: null,
        mcpGateway: null,
        mcpRegistry: null,
        knowledgeSource: null,
      },
    },
  });
  for (const [suffix, body] of Object.entries({
    "tool-exclusions": { excludedToolIds: [] },
    "subagent-exclusions": { excludedSubagentIds: [] },
    "knowledge-source-exclusions": { excludedConnectorIds: [] },
    "skill-exclusions": { excludedSkillIds: [], skills: [] },
  })) {
    await mswControl.use({
      method: "get",
      url: `/api/agents/${gateway.id}/${suffix}`,
      body,
    });
  }
  const catalog = makeCatalogItem({
    id: "test-env-catalog",
    name: "Environment test tools",
    environmentId: gateway.environmentId,
    toolCount: 1,
  });
  const tool = {
    id: "test-env-tool",
    name: "test__lookup",
    rawName: "lookup",
    description: "Test lookup",
    catalogId: catalog.id,
    agentId: null,
    delegateToAgentId: null,
    parameters: {},
    meta: null,
    clonedPendingDiscovery: false,
    policiesAutoConfiguredAt: null,
    policiesAutoConfiguringStartedAt: null,
    policiesAutoConfiguredReasoning: null,
    policiesAutoConfiguredModel: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    mcpServerId: null,
    credentialResolutionMode: "static",
  };
  await mswControl.use({
    method: "get",
    url: "/api/internal_mcp_catalog",
    body: [catalog],
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${gateway.id}/tools`,
    body: [tool],
  });
  await mswControl.use({
    method: "get",
    url: `/api/internal_mcp_catalog/${catalog.id}/tools`,
    body: [tool],
  });
  let environmentRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/environments")
      environmentRequests++;
  });
  const environmentResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/environments",
  );
  await page.goto(`/mcp/gateways/${gateway.id}`);
  expect((await environmentResponse).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: gateway.name })).toBeVisible();
  const requestsBeforeSettings = environmentRequests;
  await page.getByTestId("agent-setup-step-settings").click();
  const selector = page.getByTestId(E2eTestId.SelectEnvironment);
  await expect(selector).toBeVisible();
  await selector.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("settings.png"),
    fullPage: true,
  });
  expect(environmentRequests).toBe(requestsBeforeSettings);
  await expect(selector).toHaveText("Restricted test environment", {
    timeout: 3000,
  });
  const warning = page
    .getByRole("alert")
    .filter({ hasText: "not in this environment" });
  await expect(warning).toHaveCount(0);

  // Remount Settings with the same complete list: no refresh or environment
  // change is necessary for the saved selection to survive.
  await page.getByTestId("agent-setup-step-connect").click();
  await page.getByTestId("agent-setup-step-settings").click();
  await expect(selector).toHaveText("Restricted test environment");
  expect(environmentRequests).toBe(requestsBeforeSettings);
  await expect(warning).toHaveCount(0);

  const renamed = { ...gateway, name: "Renamed gateway" };
  await mswControl.use({
    method: "put",
    url: `/api/agents/${gateway.id}`,
    body: renamed,
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${gateway.id}`,
    body: renamed,
  });
  await page
    .getByRole("textbox", { name: "Name *", exact: true })
    .fill(renamed.name);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toBeEnabled();
  const savedRequest = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname === `/api/agents/${gateway.id}`,
  );
  await save.click();
  const payload = (await savedRequest).postDataJSON();
  expect(payload.name).toBe(renamed.name);
  expect(payload).not.toHaveProperty("environmentId");
  await expect(save).toBeDisabled();
  await expect(selector).toHaveText("Restricted test environment");

  // A deliberate move still works and still blocks incompatible tools.
  await selector.click();
  await expect(
    page.getByRole("option", {
      name: /^Restricted test environment/,
    }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await expect(selector).toHaveText("Default");
  await expect(warning).toBeVisible();
  await expect(save).toBeDisabled();
});
