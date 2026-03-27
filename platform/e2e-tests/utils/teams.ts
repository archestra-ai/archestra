import { expect, type Locator, type Page } from "@playwright/test";
import { clickButton } from "./dialogs";

function getTeamRow(page: Page, teamName: string): Locator {
  return page.getByRole("row", {
    name: new RegExp(teamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
  });
}

async function searchForTeam(
  page: Page,
  teamName: string,
): Promise<void> {
  const searchInput = page.getByPlaceholder(/Search teams/i);
  await expect(searchInput).toBeVisible({ timeout: 10_000 });
  await searchInput.fill(teamName);
}

async function getVisibleTeamRow(
  page: Page,
  teamName: string,
): Promise<Locator> {
  await searchForTeam(page, teamName);
  const row = getTeamRow(page, teamName);
  await expect(row).toBeVisible({ timeout: 10_000 });
  return row;
}

export async function clickTeamActionButton(params: {
  page: Page;
  teamName: string;
  actionName: string | RegExp;
}): Promise<void> {
  const row = await getVisibleTeamRow(params.page, params.teamName);
  const actionButton = row.getByRole("button", { name: params.actionName });
  await expect(actionButton).toBeVisible({ timeout: 10_000 });
  await actionButton.click();
}

export async function createTeam(params: {
  page: Page;
  name: string;
  description: string;
}): Promise<void> {
  const createTeamButton = params.page.getByRole("button", {
    name: "Create Team",
  });
  await expect(createTeamButton).toBeVisible({ timeout: 15_000 });
  await expect(createTeamButton).toBeEnabled({ timeout: 10_000 });
  await createTeamButton.click();

  const dialog = params.page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await params.page.getByLabel("Team Name").fill(params.name);
  await params.page.getByLabel("Description").fill(params.description);
  await dialog.getByRole("button", { name: "Create Team" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await getVisibleTeamRow(params.page, params.name);
}

export async function deleteTeamByName(
  page: Page,
  teamName: string,
): Promise<void> {
  await clickTeamActionButton({
    page,
    teamName,
    actionName: "Delete",
  });
  await expect(page.getByText(/Are you sure/i)).toBeVisible({ timeout: 5000 });
  await clickButton({ page, options: { name: "Delete", exact: true } });
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });
}
