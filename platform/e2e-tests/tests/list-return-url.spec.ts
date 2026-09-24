import { E2eTestId } from "@archestra/shared";
import { mergeTests } from "@playwright/test";
import { expect, test as uiTest } from "../fixtures";
import { selectAgentTableView, waitForElementWithReload } from "../utils";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

// Regression test for: filtering/searching a list page, opening an object's
// detail page, then navigating back used to drop the list's filters. The fix
// is the shared `useListReturnHref`/`PageBackLink` mechanism, exercised here
// end-to-end through the agents list — any other list page wired the same
// way is covered by the underlying hook's unit tests.
test("restores a list page's search filter after visiting a detail page and navigating back", async ({
  page,
  request,
  createAgent,
  deleteAgent,
  makeRandomString,
  goToPage,
}) => {
  const agentName = makeRandomString(10, "list-return-url-");
  const createResponse = await createAgent(request, agentName, "agent");
  const agent = await createResponse.json();

  try {
    await goToPage(page, "/agents");
    await selectAgentTableView(page);

    const searchInput = page.getByPlaceholder("Search agents by name");
    await waitForElementWithReload(page, searchInput);
    await searchInput.fill(agentName);

    await expect(page).toHaveURL(new RegExp(`name=${agentName}`), {
      timeout: 10_000,
    });

    const agentLink = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByRole("link", { name: agentName, exact: true });
    await waitForElementWithReload(page, agentLink);

    const agentDetailUrl = new RegExp(`/agents/${agent.id}$`);
    await expect(async () => {
      if (!page.url().match(agentDetailUrl)) {
        await agentLink.click();
      }
      await expect(page).toHaveURL(agentDetailUrl, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });

    // Scoped to <main> because the sidebar also has a nav item labeled
    // "Agents" — the back link and that nav item would otherwise be
    // ambiguous by accessible name alone.
    const backLink = page
      .getByRole("main")
      .getByRole("link", { name: "Agents", exact: true });
    await expect(async () => {
      if (page.url().match(agentDetailUrl)) {
        await backLink.click();
      }
      await expect(page).toHaveURL(new RegExp(`name=${agentName}`), {
        timeout: 3_000,
      });
    }).toPass({ timeout: 20_000 });

    await expect(page).not.toHaveURL(agentDetailUrl);
    await expect(searchInput).toHaveValue(agentName);
  } finally {
    await deleteAgent(request, agent.id);
  }
});
