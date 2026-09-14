import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeUserPermissions } from "@/mocks/data/auth";
import {
  type ExternalAgent,
  makeAgent,
  makeAgentCatalog,
} from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

function makeExternalAgent(
  overrides: Partial<ExternalAgent> = {},
): ExternalAgent {
  return {
    id: "external-agent",
    organizationId: "org-1",
    name: "Partner Agent",
    description: "Delegates work to a partner system",
    discoveryMode: "well_known",
    discoveryUrl: "https://agent.example.com",
    agentCard: { name: "Partner Agent" },
    cardHash: "card-hash",
    lastDiscoveredAt: "2026-09-08T12:00:00.000Z",
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    scope: "org",
    authorId: "user-1",
    createdByServiceAccountId: null,
    authorName: "Test User",
    createdBy: {
      id: "user-1",
      type: "user",
      name: "Test User",
      email: "test@example.com",
    },
    teams: [],
    users: [],
    connection: {
      id: "connection-1",
      remoteAgentId: "external-agent",
      selectedInterface: {
        url: "https://agent.example.com/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
      securityRequirement: null,
      authType: "none",
      authConfig: {},
      enabled: true,
      lastVerifiedAt: "2026-09-08T12:00:00.000Z",
      createdAt: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-08T12:00:00.000Z",
      hasCredential: false,
    },
    toolId: "tool-1",
    assignmentCount: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

test.describe("Agents", () => {
  test("selects and bulk modifies regular and external A2A agents together", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Research Agent",
    });
    const externalAgent = makeExternalAgent();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [regularAgent],
        externalAgents: [externalAgent],
      }),
    });

    await agentsPage.goto();

    await expect(agentsPage.rowFor("Research Agent")).toBeVisible();
    const externalCard = agentsPage.table.getByTestId(
      "a2a-remote-agent-card-external-agent",
    );
    await expect(externalCard).toBeVisible();
    await expect(externalCard.getByText("A2A", { exact: true })).toBeVisible();
    await expect(
      externalCard.getByRole("checkbox", { name: "Select Partner Agent" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "View as table" }),
    ).toHaveCount(1);

    await page.getByRole("button", { name: "View as table" }).click();
    await expect(
      agentsPage.table.getByRole("row", { name: /Partner Agent.*A2A/ }),
    ).toBeVisible();
    await expect(
      agentsPage.table.getByRole("row", { name: /Research Agent/ }),
    ).toBeVisible();

    const regularCheckbox = page.getByRole("checkbox", {
      name: "Select Research Agent",
    });
    const externalCheckbox = page.getByRole("checkbox", {
      name: "Select Partner Agent",
    });
    const bulkCount = page
      .locator('[data-slot="bulk-actions-bar"]')
      .getByText("2 agents selected");
    await regularCheckbox.click();
    await externalCheckbox.click();
    await expect(bulkCount).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeEnabled();

    await mswControl.use({
      method: "patch",
      url: "/api/agents/bulk",
      body: {
        succeeded: [{ id: regularAgent.id, name: regularAgent.name }],
        failed: [],
      },
    });
    await mswControl.use({
      method: "put",
      url: "/api/a2a/remote-agents/:id",
      body: externalAgent,
    });
    await page.getByRole("button", { name: "Edit visibility" }).click();
    const visibilityDialog = page.getByRole("dialog", {
      name: "Edit visibility",
    });
    await visibilityDialog.getByRole("button", { name: /Personal/ }).click();
    await visibilityDialog
      .getByRole("button", { name: /Organization/ })
      .click();
    const regularVisibilityRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/agents/bulk") &&
        request.method() === "PATCH",
    );
    const externalVisibilityRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/a2a/remote-agents/external-agent") &&
        request.method() === "PUT",
    );
    await visibilityDialog.getByRole("button", { name: "Apply" }).click();
    expect(
      JSON.parse((await regularVisibilityRequest).postData() ?? "{}"),
    ).toEqual({
      ids: [regularAgent.id],
      scope: "org",
      teams: [],
      users: [],
    });
    expect(
      JSON.parse((await externalVisibilityRequest).postData() ?? "{}"),
    ).toEqual({ scope: "org", teams: [], users: [] });
    await expect(bulkCount).toBeHidden();

    await regularCheckbox.click();
    await externalCheckbox.click();
    await mswControl.use({
      method: "delete",
      url: "/api/agents/bulk",
      body: {
        succeeded: [{ id: regularAgent.id, name: regularAgent.name }],
        failed: [],
      },
    });
    await mswControl.use({
      method: "delete",
      url: "/api/a2a/remote-agents/:id",
      body: { success: true },
    });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const regularDeleteRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/agents/bulk") &&
        request.method() === "DELETE",
    );
    const externalDeleteRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/a2a/remote-agents/external-agent") &&
        request.method() === "DELETE",
    );
    await page
      .getByRole("dialog", { name: "Delete agents" })
      .getByRole("button", { name: "Delete agents" })
      .click();
    expect(JSON.parse((await regularDeleteRequest).postData() ?? "{}")).toEqual(
      { ids: [regularAgent.id] },
    );
    await externalDeleteRequest;
    await expect(bulkCount).toBeHidden();
  });

  test("shows filtered empty views without waiting for external agents", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog(),
    });

    for (const [query, emptyMessage] of [
      ["status=deleted", "No deleted agents found."],
      ["labels=department%3Aresearch", "No agents match your filters"],
      ["providerApiKeyId=organization-default", "No agents match your filters"],
    ]) {
      await page.goto(`/agents?${query}`);
      await expect(agentsPage.table.getByText(emptyMessage)).toBeVisible();
    }
  });

  test("fails closed when selecting all matching agents cannot be loaded", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Research Agent",
    });
    const externalAgent = makeExternalAgent();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [regularAgent],
        externalAgents: [externalAgent],
        total: 3,
        agentTotal: 2,
      }),
    });
    await agentsPage.goto();

    await page.getByRole("checkbox", { name: "Select Research Agent" }).click();
    await page.getByRole("checkbox", { name: "Select Partner Agent" }).click();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      status: 500,
      body: { error: { message: "catalog unavailable" } },
    });
    await page
      .getByRole("button", {
        name: "Select all 3 agents that match the current filters.",
      })
      .click();

    await expect(
      page.getByText("Couldn't select all matching agents"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeDisabled();
  });

  test("blocks an open bulk dialog when all-matching refresh fails", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Research Agent",
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [regularAgent],
        total: 2,
        agentTotal: 2,
      }),
    });
    await agentsPage.goto();

    await page.getByRole("checkbox", { name: "Select Research Agent" }).click();
    await page
      .getByRole("button", {
        name: "Select all 2 agents that match the current filters.",
      })
      .click();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      status: 500,
      body: { error: { message: "catalog unavailable" } },
    });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Delete agents" });

    await expect(
      page.getByText("Couldn't select all matching agents"),
    ).toBeVisible();
    await expect(confirm).toBeDisabled();
  });

  test("seeds bulk visibility from the refreshed all-matching rows", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Research Agent",
      scope: "personal",
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [regularAgent],
        total: 2,
        agentTotal: 2,
      }),
    });
    await agentsPage.goto();

    await page.getByRole("checkbox", { name: "Select Research Agent" }).click();
    await page
      .getByRole("button", {
        name: "Select all 2 agents that match the current filters.",
      })
      .click();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [{ ...regularAgent, scope: "org" }],
      }),
    });
    await page.getByRole("button", { name: "Edit visibility" }).click();

    const visibilityDialog = page.getByRole("dialog", {
      name: "Edit visibility",
    });
    await expect(
      visibilityDialog.getByRole("button", { name: /Organization/ }),
    ).toBeVisible();
  });

  test("does not open bulk visibility for filters that changed during refresh", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Research Agent",
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [regularAgent],
        total: 2,
        agentTotal: 2,
      }),
    });
    await agentsPage.goto();
    await page.getByRole("checkbox", { name: "Select Research Agent" }).click();
    await page
      .getByRole("button", {
        name: "Select all 2 agents that match the current filters.",
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeEnabled();

    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      delayMs: 3000,
      body: makeAgentCatalog({ agents: [regularAgent] }),
    });
    const refreshResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/agent-catalog" &&
        url.searchParams.get("selectableOnly") === "true"
      );
    });
    await page.getByRole("button", { name: "Edit visibility" }).click();
    await page.evaluate(() => {
      window.history.pushState({}, "", "/agents?status=deleted");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page).toHaveURL(/status=deleted/);
    await refreshResponse;

    await expect(
      page.getByRole("dialog", { name: "Edit visibility" }),
    ).toHaveCount(0);
  });

  test("selects later regular agents without counting unselectable external rows", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const firstAgent = makeAgent({ id: "regular-1", name: "Regular One" });
    const secondAgent = makeAgent({ id: "regular-2", name: "Regular Two" });
    await mswControl.use({
      method: "get",
      url: "/api/user/permissions",
      body: makeUserPermissions({
        agent: ["read", "update", "delete"],
        agentSettings: [],
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [firstAgent],
        externalAgents: [makeExternalAgent()],
        total: 502,
        agentTotal: 2,
        externalAgentTotal: 500,
      }),
    });
    await agentsPage.goto();
    await expect(
      page.getByRole("checkbox", { name: "Select Partner Agent" }),
    ).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select Regular One" }).click();

    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({ agents: [firstAgent, secondAgent] }),
    });
    const selectableRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/agent-catalog" &&
        url.searchParams.get("selectableOnly") === "true"
      );
    });
    await page
      .getByRole("button", {
        name: "Select all 2 agents that match the current filters.",
      })
      .click();
    await selectableRequest;

    await expect(
      page
        .locator('[data-slot="bulk-actions-bar"]')
        .getByText("2 agents selected"),
    ).toBeVisible();
  });

  test("blocks bulk actions when a refreshed selection exceeds the limit", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Research Agent",
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [regularAgent],
        total: 2,
        agentTotal: 2,
      }),
    });
    await agentsPage.goto();
    await page.getByRole("checkbox", { name: "Select Research Agent" }).click();

    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({
        agents: [makeAgent({ id: "agent-500", name: "Agent 500" })],
        total: 501,
        agentTotal: 501,
      }),
    });
    for (let batch = 4; batch >= 0; batch -= 1) {
      const agents = Array.from({ length: 100 }, (_, index) => {
        const id = batch * 100 + index;
        return makeAgent({ id: `agent-${id}`, name: `Agent ${id}` });
      });
      await mswControl.use({
        method: "get",
        url: "/api/agent-catalog",
        body: makeAgentCatalog({
          agents,
          total: 501,
          agentTotal: 501,
        }),
        once: true,
      });
    }
    await page
      .getByRole("button", {
        name: "Select all 2 agents that match the current filters.",
      })
      .click();

    await expect(
      page.getByText("Select at most 500 items at a time."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeDisabled();
  });

  test("can create and delete an agent", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const NAME = "Test Agent 1";
    const newAgent = makeAgent({ id: "agent-created", name: NAME });

    // Stage POST/create then the post-mutation GET that re-populates the
    // table. Latest-wins on the handler chain means the table reflects the
    // new agent after React Query invalidation refetches.
    await mswControl.use({
      method: "post",
      url: "/api/agents",
      body: newAgent,
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({ agents: [newAgent] }),
    });

    await agentsPage.goto();
    await expect(agentsPage.heading).toBeVisible();
    await agentsPage.createButton.click();
    await page.waitForURL("/agents/new");
    await expect(
      page.getByRole("heading", { name: "Popular agents" }),
    ).toBeHidden();
    await page.getByRole("button", { name: /Start from scratch/ }).click();
    await page
      .locator("#main-content")
      .getByRole("link", { name: "Agents" })
      .click();
    await expect(
      page.getByRole("button", { name: /Connect via A2A/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Start from scratch/ }).click();
    await page.getByRole("textbox", { name: "Name" }).fill(NAME);
    // Walk to the last step, however many the wizard has — the step list
    // depends on the record's type and grows, and only the last step offers
    // Create. Each Next is a plain state change, so this settles immediately.
    const nextButton = page.getByTestId(E2eTestId.AgentSetupNextButton);
    const submitButton = page.getByTestId(E2eTestId.AgentSetupSubmitButton);
    await expect(async () => {
      if (await submitButton.isVisible()) return;
      await nextButton.click();
      await expect(submitButton).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await submitButton.click();
    await page.waitForURL(/\/agents\/agent-created\?section=connect$/);

    await agentsPage.goto();

    await expect(agentsPage.rowFor(NAME)).toBeVisible();

    // Stage the post-delete GET ahead of clicking Delete so the refetch
    // following DELETE's onSuccess returns the empty list.
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog(),
    });
    await mswControl.use({
      method: "delete",
      url: "/api/agents/:id",
      body: { success: true },
    });

    await agentsPage.openRowMenu(NAME);
    await agentsPage.deleteButtonFor(NAME).click();
    await page.getByRole("button", { name: "Delete Agent" }).click();

    await expect(agentsPage.rowFor(NAME)).toBeHidden();
  });

  test("can clone an agent and rename it", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    const ORIGINAL = "Original Agent";
    const CLONE_DRAFT = "Original Agent (copy)";
    const CLONE = "Cloned Agent";
    const original = makeAgent({ id: "agent-original", name: ORIGINAL });
    // What the clone comes back as, before it is renamed — the rename is what
    // this test drives, so the draft must not already carry the target name.
    const clonedDraft = makeAgent({ id: "agent-cloned", name: CLONE_DRAFT });
    const cloned = makeAgent({ id: "agent-cloned", name: CLONE });

    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      body: makeAgentCatalog({ agents: [original] }),
    });
    await mswControl.use({
      method: "post",
      url: "/api/agents/:id/clone",
      body: clonedDraft,
    });
    await mswControl.use({
      method: "put",
      url: "/api/agents/:id",
      body: cloned,
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id",
      body: clonedDraft,
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id/subagent-exclusions",
      body: { excludedSubagentIds: [] },
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id/knowledge-source-exclusions",
      body: { excludedConnectorIds: [] },
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id/tool-exclusions",
      body: { excludedToolIds: [] },
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id/skill-exclusions",
      body: { excludedSkillIds: [], skills: [] },
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id/activation-skill-policy",
      body: {
        mode: "all",
        revision: 0,
        allowedReferences: [],
        excludedReferences: [],
        hiddenAllowedCount: 0,
        hiddenExcludedCount: 0,
        allowedSkills: [],
        excludedSkills: [],
      },
    });

    await agentsPage.goto();
    await expect(agentsPage.rowFor(ORIGINAL)).toBeVisible();

    await agentsPage.openRowMenu(ORIGINAL);
    await agentsPage.cloneButtonFor(ORIGINAL).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Register this after the dynamic `/api/agents/:id` override: without the
    // exact route winning, `/api/agents/all` is treated as id "all" and the
    // editor receives one agent object instead of the delegation-target array.
    await mswControl.use({
      method: "get",
      url: "/api/agents/all",
      body: [original, clonedDraft],
    });
    await dialog.getByRole("button", { name: "Clone" }).click();
    // The clone lands on its own page, open on Configuration, so it can be
    // renamed without a second navigation.
    await page.waitForURL(/\/agents\/agent-cloned$/);

    // The configuration is the page, so the clone's name is editable on the
    // screen the clone landed on.
    const nameInput = page.getByRole("textbox", { name: "Name" });
    await expect(nameInput).toHaveValue(CLONE_DRAFT);

    const save = page.getByTestId(E2eTestId.AgentSetupSubmitButton);
    // Nothing has changed yet, so there is nothing to save.
    await expect(save).toBeDisabled();
    await nameInput.fill(CLONE);
    await expect(save).toBeEnabled();

    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/agents/agent-cloned") &&
        response.request().method() === "PUT",
    );
    await save.click();
    const putBody = JSON.parse((await saved).request().postData() ?? "{}");
    expect(putBody.name).toBe(CLONE);
    // Saving stays put: the record's page is where it was being edited.
    await expect(page).toHaveURL(/\/agents\/agent-cloned$/);

    // The remaining configuration is a section of the same page, not a step
    // of a separate wizard.
    await page.getByTestId(`${E2eTestId.AgentSetupStep}-tools`).click();
    await page.waitForURL(/\/agents\/agent-cloned\?section=tools$/);
    await expect(page.getByTestId(E2eTestId.AgentToolsSection)).toBeVisible();
  });
});
