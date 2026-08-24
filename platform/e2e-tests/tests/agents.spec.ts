import { E2eTestId } from "@archestra/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import {
  clickButton,
  openAgentRowMenu,
  selectAgentTableView,
  waitForElementWithReload,
} from "../utils";

/**
 * Drive the routed setup wizard (`/<family>/new`, first step of the shared
 * AgentForm) to a submitted POST, and land on the second wizard step of the
 * created record.
 *
 * The list's Create button, the wizard's name input, and its submit render
 * before React finishes hydrating, so any interaction landing in that window
 * is silently lost — Playwright sees a visible/enabled element and reports
 * success, but the handler never ran. A longer timeout can't recover a
 * dropped interaction, so each step is driven by its observable end-state and
 * retried until that state is reached. (Same pre-hydration class as the
 * skills marketplace fix in #6339.)
 *
 * Returns the created record's id, read from the wizard URL.
 */
async function createViaWizard(
  page: Page,
  listPath: "/agents" | "/llm/proxies" | "/mcp/gateways",
  name: string,
): Promise<string> {
  const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
  await waitForElementWithReload(page, createButton);

  // Anchored: the list page behind the wizard has a "Search … by name" box,
  // which a substring match would accept as the name field before the click
  // has navigated anywhere.
  const nameField = page.getByRole("textbox", { name: /^Name\b/ });
  const submitButton = page.getByTestId(E2eTestId.AgentSetupSubmitButton);

  // 1. Open the wizard — retry the trigger until the name field mounts on
  //    the /new page. Guarded on the URL so a landed click is never re-sent.
  await expect(async () => {
    if (!page.url().includes(`${listPath}/new`)) {
      await createButton.click();
    }
    await expect(nameField).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

  // 2. Fill the name — retry until the form actually registered it, which the
  //    Next button becoming enabled confirms (it is disabled while the name
  //    is empty). fill() is idempotent, so re-filling after the input
  //    hydrates is safe and is what flips the button from disabled to enabled.
  const nextButton = page.getByTestId(E2eTestId.AgentSetupNextButton);
  await expect(async () => {
    await nameField.fill(name);
    await expect(nextButton).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // 3. Walk the remaining steps: nothing is written until the last one, whose
  //    CTA is the Create button. Each Next is a plain state change, so the
  //    loop ends as soon as the submit is on screen.
  await expect(async () => {
    if (await submitButton.isVisible()) return;
    await nextButton.click();
    await expect(submitButton).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

  // 4. Create — retry the click until the POST is dispatched. waitForRequest
  //    resolves the instant the handler runs, so a click that landed is
  //    detected immediately and never re-clicked — there is no window in which
  //    a second record could be created.
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/agents") &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await expect(async () => {
    const requestDispatched = page
      .waitForRequest(
        (request) =>
          request.url().includes("/api/agents") && request.method() === "POST",
        { timeout: 3_000 },
      )
      .catch(() => null);
    await submitButton.click();
    expect(await requestDispatched).not.toBeNull();
  }).toPass({ timeout: 20_000 });
  await createResponsePromise;

  // 5. The create lands on the new record's Connect section.
  const connectUrl = new RegExp(`${listPath}/([^/?#]+)#connect`);
  await page.waitForURL(connectUrl, { timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  const id = page.url().match(connectUrl)?.[1];
  if (!id) throw new Error(`No record id in detail URL ${page.url()}`);
  // The pointer is still where the Create button was — the bottom-right
  // corner, where the "created" toast now sits and pauses its own dismissal
  // while hovered, covering whatever lands under it. Park the pointer away.
  await page.mouse.move(0, 0);
  return id;
}

/** The delete flow of a list row: row menu (agents) or button, then confirm. */
async function deleteFromList(
  page: Page,
  { name, confirmLabel }: { name: string; confirmLabel: string },
) {
  await selectAgentTableView(page);
  const rowLocator = page.getByTestId(E2eTestId.AgentsTable).getByTitle(name);
  await waitForElementWithReload(page, rowLocator, {
    timeout: 30_000,
    intervals: [2000, 3000, 5000],
    checkEnabled: false,
  });
  await openAgentRowMenu(page, name);
  await page.getByTestId(`${E2eTestId.DeleteAgentButton}-${name}`).click();
  await clickButton({ page, options: { name: confirmLabel } });
  await expect(rowLocator).not.toBeVisible({ timeout: 10_000 });
}

test(
  "can create and delete an agent",
  {
    tag: ["@firefox", "@webkit"],
  },
  async ({ page, makeRandomString, goToPage }, testInfo) => {
    // webkit intermittently fails: delete doesn't propagate before the next
    // assertion, then create-agent-button isn't found on retry. Tracked
    // alongside MQ flakiness from https://github.com/archestra-ai/archestra/actions/runs/26282803981.
    test.skip(testInfo.project.name === "webkit", "flaky on webkit");
    test.setTimeout(120_000);

    const AGENT_NAME = makeRandomString(10, "Test Agent");
    await goToPage(page, "/agents");

    await page.waitForLoadState("domcontentloaded");

    const agentId = await createViaWizard(page, "/agents", AGENT_NAME);

    // The create lands on the Connect section, which shows the agent's A2A
    // endpoint so the user knows how to use it.
    await expect(
      page.getByText(new RegExp(`/v2/a2a/${agentId}`)).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(AGENT_NAME) }),
    ).toBeVisible({ timeout: 15_000 });

    // The wizard's steps are the edit page's: Tools & Knowledge is there.
    await page.getByRole("link", { name: "Edit" }).click();
    await page.waitForURL(new RegExp(`/agents/${agentId}/edit`), {
      timeout: 15_000,
    });
    await page.getByTestId(`${E2eTestId.AgentSetupStep}-tools`).click();
    await expect(page).toHaveURL(/step=tools/);
    await expect(page.getByTestId(E2eTestId.AgentToolsSection)).toBeVisible({
      timeout: 15_000,
    });

    await goToPage(page, "/agents");
    await selectAgentTableView(page);
    const agentLocator = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(AGENT_NAME);
    await waitForElementWithReload(page, agentLocator, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });

    // The whole row opens the detail page, not just the name link: click the
    // icon cell, which carries no control of its own. Retried until the URL
    // changes, for the same pre-hydration reason as the wizard steps above.
    const agentDetailUrl = new RegExp(`/agents/${agentId}$`);
    // The name cell truncates long names in the DOM and carries the full
    // name as its title, so find the row by that title, not by text.
    const rowIconCell = page
      .getByTestId(E2eTestId.AgentsTable)
      .locator("tr")
      .filter({ has: page.getByTitle(AGENT_NAME) })
      .locator('td[data-column-id="icon"]');
    await expect(async () => {
      if (!page.url().match(agentDetailUrl)) {
        await rowIconCell.click();
      }
      await expect(page).toHaveURL(agentDetailUrl, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });

    // Delete created agent from the table
    await goToPage(page, "/agents");
    await selectAgentTableView(page);
    await waitForElementWithReload(page, agentLocator, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });
    await openAgentRowMenu(page, AGENT_NAME);
    await page
      .getByTestId(`${E2eTestId.DeleteAgentButton}-${AGENT_NAME}`)
      .click();
    await clickButton({ page, options: { name: "Delete Agent" } });

    // Wait for deletion to complete
    await expect(agentLocator).not.toBeVisible({ timeout: 10000 });
  },
);

test(
  "can create and delete an LLM proxy",
  {
    tag: ["@firefox", "@webkit"],
  },
  async ({ page, makeRandomString, goToPage }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "flaky on webkit");
    test.setTimeout(120_000);

    const PROXY_NAME = makeRandomString(10, "Test LLM Proxy");
    await goToPage(page, "/llm/proxies");

    await page.waitForLoadState("domcontentloaded");

    const proxyId = await createViaWizard(page, "/llm/proxies", PROXY_NAME);

    // The create lands on the proxy's Connect section (endpoint + auth).
    await expect(page).toHaveURL(new RegExp(`/llm/proxies/${proxyId}#connect`));
    await expect(page.getByRole("tab", { name: "Virtual keys" })).toBeVisible({
      timeout: 15_000,
    });

    // Delete created LLM proxy from the table
    await goToPage(page, "/llm/proxies");
    await deleteFromList(page, {
      name: PROXY_NAME,
      confirmLabel: "Delete LLM Proxy",
    });
  },
);

test(
  "can create an MCP gateway and land on the pre-selected connection guide",
  {
    tag: ["@firefox", "@webkit"],
  },
  async ({ page, makeRandomString, goToPage }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "flaky on webkit");
    test.setTimeout(120_000);

    const GATEWAY_NAME = makeRandomString(10, "Test MCP Gateway");
    await goToPage(page, "/mcp/gateways");

    await page.waitForLoadState("domcontentloaded");

    const gatewayId = await createViaWizard(
      page,
      "/mcp/gateways",
      GATEWAY_NAME,
    );

    // The create lands on the connection instructions, whose guided-setup link
    // lands on /connection with the new gateway pre-selected.
    await page
      .getByRole("link", { name: /Set up a client step by step/ })
      .click();
    await page.waitForURL(
      new RegExp(`/connection\\?gatewayId=${gatewayId}&from=`),
      { timeout: 15_000 },
    );

    // Clean up: back to the table and delete the gateway.
    await goToPage(page, "/mcp/gateways");
    await deleteFromList(page, {
      name: GATEWAY_NAME,
      confirmLabel: "Delete MCP Gateway",
    });
  },
);
