import { E2eTestId } from "@archestra/shared";
import type { Page } from "@playwright/test";

// Row actions (Delete, Clone, Version history) live inside the row's
// "More actions" dropdown (see frontend/src/app/agents/agent-actions.tsx).
// The dropdown content is only mounted when the trigger is clicked, so we
// open it before clicking the test-id'd action. We scope by the agent-name
// title cell rather than row accessible name, because the DataTable truncates
// names with CSS (the full string lives on the title attribute, not in
// visible text).
export async function openAgentRowMenu(
  page: Page,
  agentName: string,
): Promise<void> {
  const row = page
    .getByTestId(E2eTestId.AgentsTable)
    .locator("tr")
    .filter({
      has: page.getByTitle(agentName, { exact: true }),
    });
  await row.getByRole("button", { name: /more actions/i }).click();
}
