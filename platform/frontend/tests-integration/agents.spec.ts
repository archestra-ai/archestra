import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeUserPermissions } from "@/mocks/data/auth";
import {
  makeAgent,
  makeAgentCatalog,
  makeExternalAgent,
} from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

test.describe("Agents", () => {
  test("keeps count columns compact as the table grows", async ({
    page,
    agentsPage,
    mswControl,
  }) => {
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/agent-catalog",
        query: { pinned: "false" },
        body: makeAgentCatalog({
          agents: [
            makeAgent({
              name: "Research and documentation assistant",
              accessAllTools: true,
              accessAllSubagents: true,
            }),
          ],
        }),
      },
      {
        method: "get",
        url: "/api/agent-catalog",
        query: { pinned: "true" },
        body: makeAgentCatalog(),
      },
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await agentsPage.goto();
    await page.getByRole("button", { name: "View as table" }).click();
    const table = agentsPage.table.getByRole("table");
    await expect(table.getByText("All", { exact: true })).toHaveCount(2);

    const widths: number[][] = [];
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const sizes: number[] = [];
      for (const name of ["Name", "Tools", "Subagents"]) {
        const header = table.getByRole("columnheader", { name, exact: true });
        await expect(header).toBeVisible();
        const bounds = await header.boundingBox();
        expect(bounds).not.toBeNull();
        sizes.push(bounds?.width ?? 0);
      }
      const [name, tools, subagents] = sizes;
      expect(tools).toBeLessThanOrEqual(120);
      expect(subagents).toBeLessThanOrEqual(120);
      expect(name).toBeGreaterThan(tools + subagents);
      widths.push(sizes);
    }
    expect(widths[1][0]).toBeGreaterThan(widths[0][0]);
    expect(widths[1][1]).toBeCloseTo(widths[0][1], 0);
    expect(widths[1][2]).toBeCloseTo(widths[0][2], 0);
  });

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
      query: { pinned: "false" },
      body: makeAgentCatalog({
        agents: [regularAgent],
        externalAgents: [externalAgent],
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
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
    // Every agent, external ones included, is shared through grants on its
    // own Permissions section, so a selection offers no bulk sharing.
    await expect(
      page.getByRole("button", { name: "Share", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeEnabled();

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
      query: { pinned: "false" },
      body: makeAgentCatalog({
        agents: [regularAgent],
        externalAgents: [externalAgent],
        total: 3,
        agentTotal: 2,
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
    });
    await agentsPage.goto();

    await page.getByRole("checkbox", { name: "Select Research Agent" }).click();
    await page.getByRole("checkbox", { name: "Select Partner Agent" }).click();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { selectableOnly: "true" },
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
      query: { pinned: "false" },
      body: makeAgentCatalog({
        agents: [regularAgent],
        total: 2,
        agentTotal: 2,
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { selectableOnly: "true" },
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
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeEnabled();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { selectableOnly: "true" },
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
        organizationSettings: [],
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "false" },
      body: makeAgentCatalog({
        agents: [firstAgent],
        externalAgents: [makeExternalAgent()],
        total: 502,
        agentTotal: 2,
        externalAgentTotal: 500,
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
    });
    await agentsPage.goto();
    await expect(
      page.getByRole("checkbox", { name: "Select Partner Agent" }),
    ).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select Regular One" }).click();

    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { selectableOnly: "true" },
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
    const externalAgent = makeExternalAgent();
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "false" },
      body: makeAgentCatalog({
        externalAgents: [externalAgent],
        total: 2,
        agentTotal: 0,
        externalAgentTotal: 2,
      }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
    });
    await agentsPage.goto();
    await page.getByRole("checkbox", { name: "Select Partner Agent" }).click();

    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { selectableOnly: "true" },
      body: makeAgentCatalog({
        externalAgents: [
          makeExternalAgent({ id: "agent-500", name: "Agent 500" }),
        ],
        total: 501,
        agentTotal: 0,
        externalAgentTotal: 501,
      }),
    });
    for (let batch = 4; batch >= 0; batch -= 1) {
      const agents = Array.from({ length: 100 }, (_, index) => {
        const id = batch * 100 + index;
        return makeExternalAgent({ id: `agent-${id}`, name: `Agent ${id}` });
      });
      await mswControl.use({
        method: "get",
        url: "/api/agent-catalog",
        query: { selectableOnly: "true" },
        body: makeAgentCatalog({
          externalAgents: agents,
          total: 501,
          agentTotal: 0,
          externalAgentTotal: 501,
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
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeDisabled();
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
      query: { pinned: "false" },
      body: makeAgentCatalog({ agents: [original] }),
    });
    await mswControl.use({
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
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
