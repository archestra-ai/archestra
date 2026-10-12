import { E2eTestId } from "@archestra/shared";
import { expect, type Page } from "@playwright/test";

// The agents list is always a table now; tests wait for it before reaching
// into its rows.
export async function waitForAgentsTable(page: Page): Promise<void> {
  await expect(page.getByTestId(E2eTestId.AgentsTable)).toBeVisible({
    timeout: 20_000,
  });
}

// Row actions (Delete, Clone, Version history) live inside the row's
// "More actions" dropdown (see frontend/src/app/agents/agent-actions.tsx).
// The dropdown content is only mounted when the trigger is clicked, so we
// open it before clicking the test-id'd action. The trigger's accessible name
// includes the full agent name even when the visible name cell is truncated.
export async function openAgentRowMenu(
  page: Page,
  agentName: string,
): Promise<void> {
  await page
    .getByTestId(E2eTestId.AgentsTable)
    .getByRole("button", {
      name: `More actions ${agentName}`,
      exact: true,
    })
    .click();
}
