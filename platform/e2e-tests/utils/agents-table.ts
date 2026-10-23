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
// The dropdown content is only mounted when the trigger is clicked. A late
// catalog response re-renders the page and can close a just-opened menu, so
// opening and clicking are retried together. The trigger's accessible name
// includes the full agent name even when the visible name cell is truncated.
export async function clickAgentRowMenuItem(
  page: Page,
  { agentName, itemTestId }: { agentName: string; itemTestId: string },
): Promise<void> {
  const trigger = page.getByTestId(E2eTestId.AgentsTable).getByRole("button", {
    name: `More actions ${agentName}`,
    exact: true,
  });
  await expect(async () => {
    await page.keyboard.press("Escape");
    await trigger.click();
    await page.getByTestId(itemTestId).click({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}
