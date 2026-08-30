import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent, makeAgentsList } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

test.describe("Agents", () => {
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
      url: "/api/agents",
      body: makeAgentsList({ agents: [newAgent] }),
    });

    await agentsPage.goto();
    await expect(agentsPage.heading).toBeVisible();
    await agentsPage.createButton.click();
    await page.waitForURL("/agents/new");
    await page.getByRole("textbox", { name: "Name" }).fill(NAME);
    await page.getByTestId(E2eTestId.AgentSetupNextButton).click();
    await page.getByTestId(E2eTestId.AgentSetupNextButton).click();
    await page.getByTestId(E2eTestId.AgentSetupSubmitButton).click();
    await page.waitForURL(/\/agents\/agent-created#connect$/);

    await agentsPage.goto();

    await expect(agentsPage.rowFor(NAME)).toBeVisible();

    // Stage the post-delete GET ahead of clicking Delete so the refetch
    // following DELETE's onSuccess returns the empty list.
    await mswControl.use({
      method: "get",
      url: "/api/agents",
      body: makeAgentsList({ agents: [] }),
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
    const CLONE = "Cloned Agent";
    const original = makeAgent({ id: "agent-original", name: ORIGINAL });
    const cloned = makeAgent({ id: "agent-cloned", name: CLONE });

    await mswControl.use({
      method: "get",
      url: "/api/agents",
      body: makeAgentsList({ agents: [original] }),
    });
    await mswControl.use({
      method: "post",
      url: "/api/agents/:id/clone",
      body: cloned,
    });
    await mswControl.use({
      method: "put",
      url: "/api/agents/:id",
      body: cloned,
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents/:id",
      body: cloned,
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
      body: [original, cloned],
    });
    await dialog.getByRole("button", { name: "Clone" }).click();
    await page.waitForURL(/\/agents\/agent-cloned\/edit\?step=configuration$/);

    const nameInput = page.getByRole("textbox", { name: "Name" });
    await nameInput.fill(CLONE);
    await page.getByTestId(E2eTestId.AgentSetupNextButton).click();
    await page.waitForURL(/step=tools/);
    await page.getByTestId(E2eTestId.AgentSetupNextButton).click();
    await page.waitForURL(/step=advanced/);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForURL(/\/agents\/agent-cloned$/);

    await expect(page.getByRole("heading", { name: CLONE })).toBeVisible();
  });
});
