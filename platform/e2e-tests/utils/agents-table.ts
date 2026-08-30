import { E2eTestId } from "@archestra/shared";
import { expect, type Page } from "@playwright/test";

// Agent-family list pages remember their table/card preference. Tests that
// exercise table-only interactions must choose the table explicitly instead
// of depending on a fresh browser context or the page's default layout.
export async function selectAgentTableView(page: Page): Promise<void> {
  const tableToggle = page.getByRole("button", { name: "View as table" });

  // Retry until React has hydrated and the click changes observable state.
  // A click that lands before hydration can otherwise appear successful while
  // leaving the card layout selected.
  await expect(async () => {
    if ((await tableToggle.getAttribute("aria-pressed")) !== "true") {
      await tableToggle.click();
    }
    await expect(tableToggle).toHaveAttribute("aria-pressed", "true");
  }).toPass({ timeout: 20_000 });

  await expect(page.getByTestId(E2eTestId.AgentsTable)).toBeVisible();
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
