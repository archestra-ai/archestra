import { mergeTests } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

const AUDIT_LOGS_PATH = "/audit/logs";

test.describe("Audit log UI", {
  tag: ["@firefox", "@webkit"],
}, () => {
  test("admin sees the Audit tab on the Logs page", async ({
    adminPage,
    goToAdminPage,
  }) => {
    await goToAdminPage("/llm/logs");
    await adminPage.waitForLoadState("domcontentloaded");

    // Three tabs: LLM Proxy, MCP Gateway, Audit. Audit is only rendered with
    // auditLog:read permission, which admin has.
    await expect(
      adminPage.getByRole("link", { name: "Audit", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    await adminPage.getByRole("link", { name: "Audit", exact: true }).click();

    await adminPage.waitForURL(`**${AUDIT_LOGS_PATH}**`, { timeout: 15_000 });
    expect(adminPage.url()).toContain(AUDIT_LOGS_PATH);
  });

  test("admin lands on /audit/logs and the table renders", async ({
    adminPage,
    goToAdminPage,
  }) => {
    await goToAdminPage(AUDIT_LOGS_PATH);
    await adminPage.waitForLoadState("domcontentloaded");

    // Page heading and filter controls are part of the audit log table contract.
    await expect(
      adminPage.getByPlaceholder(/Search audit events/i),
    ).toBeVisible({ timeout: 15_000 });

    // Column headers are stable and part of the visual contract.
    for (const column of ["When", "Actor", "Action", "Resource", "Where"]) {
      await expect(
        adminPage.getByRole("columnheader", { name: column }),
      ).toBeVisible();
    }
  });

  test("audit table shows resource type only — never the resource id — in the Resource column", async ({
    adminPage,
    goToAdminPage,
  }) => {
    await goToAdminPage(AUDIT_LOGS_PATH);
    await adminPage.waitForLoadState("domcontentloaded");

    // Wait for at least one row OR the empty-state to render so we know the
    // query settled.
    const firstRow = adminPage.locator("tbody tr").first();
    await firstRow.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      /* empty state is acceptable; the next assertion handles it */
    });

    const resourceCells = adminPage.locator("tbody tr td:nth-child(4)");
    const count = await resourceCells.count();
    if (count === 0) return; // empty state, nothing to assert

    // Regression guard for post-Phase-11 cleanup: resource_id must not appear
    // in the table — it now lives in the detail dialog instead.
    for (let i = 0; i < count; i++) {
      const text = (await resourceCells.nth(i).innerText()).trim();
      // UUID-shaped text should not appear in the cell.
      expect(text).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    }
  });

  test("clicking a row opens the event detail dialog", async ({
    adminPage,
    goToAdminPage,
  }) => {
    await goToAdminPage(AUDIT_LOGS_PATH);
    await adminPage.waitForLoadState("domcontentloaded");

    // Only real data rows have cells with data-column-id; the empty-state row
    // is a single colSpan <tr> without that attribute, so this selector skips it.
    const firstRow = adminPage
      .locator("tbody tr:has(td[data-column-id])")
      .first();
    const hasRow = await firstRow
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    // Test is meaningful only when the org already has at least one event.
    // The shared admin fixture has produced many sign-ins, so this should
    // virtually always be true; skip cleanly if it isn't.
    test.skip(!hasRow, "no audit rows in the test environment");

    await firstRow.click();
    await expect(adminPage.getByRole("dialog")).toBeVisible({
      timeout: 10_000,
    });
    // Detail dialog contract: identifies the actor and the action.
    await expect(adminPage.getByRole("dialog")).toContainText(/When/i);
    await expect(adminPage.getByRole("dialog")).toContainText(/Actor/i);
  });

  test("deep link with ?event=<id> opens the event detail dialog", async ({
    adminPage,
    goToAdminPage,
    makeRandomString,
    createTeam,
    deleteTeam,
  }) => {
    // Team creation is audited (team.created), so it gives the test a
    // deterministic event tied to a unique resource id.
    const createResponse = await createTeam(
      adminPage.request,
      makeRandomString(10, "audit-deep-link"),
    );
    const team = (await createResponse.json()) as { id: string };

    try {
      // The audit hook records the event after the response is sent, so poll
      // until the team.created event is queryable.
      let eventId: string | undefined;
      await expect
        .poll(
          async () => {
            const response = await adminPage.request.get(
              `${UI_BASE_URL}/api/audit-logs?resourceType=team&limit=50`,
            );
            if (!response.ok()) return undefined;
            const body = (await response.json()) as {
              data: Array<{ id: string; resourceId: string | null }>;
            };
            eventId = body.data.find(
              (event) => event.resourceId === team.id,
            )?.id;
            return eventId;
          },
          { timeout: 15_000 },
        )
        .toBeDefined();

      await goToAdminPage(`${AUDIT_LOGS_PATH}?event=${eventId}`);

      const dialog = adminPage.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog).toContainText("Event details");
      // The dialog shows the deep-linked event: the created team's id
      // appears as the resource id.
      await expect(dialog).toContainText(team.id);
    } finally {
      await deleteTeam(adminPage.request, team.id);
    }
  });

  test("member does not see the Audit tab and is blocked from direct nav", async ({
    memberPage,
    goToMemberPage,
  }) => {
    await goToMemberPage("/llm/logs");
    await memberPage.waitForLoadState("domcontentloaded");

    // Member lacks auditLog:read so the tab is hidden entirely.
    await expect(
      memberPage.getByRole("link", { name: "Audit", exact: true }),
    ).toHaveCount(0);

    // Direct navigation should be blocked by the page-permission guard;
    // the member stays at the URL but sees the 403 forbidden page.
    await goToMemberPage(AUDIT_LOGS_PATH);
    await memberPage.waitForLoadState("domcontentloaded");
    await expect(
      memberPage.getByText("You don't have permission to access this page."),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("editor does not see the Audit tab", async ({
    editorPage,
    goToEditorPage,
  }) => {
    await goToEditorPage("/llm/logs");
    await editorPage.waitForLoadState("domcontentloaded");

    // Editor also lacks auditLog:read — the Audit tab must be hidden.
    await expect(
      editorPage.getByRole("link", { name: "Audit", exact: true }),
    ).toHaveCount(0);
  });
});
