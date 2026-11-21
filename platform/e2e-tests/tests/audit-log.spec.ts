import type { APIRequestContext } from "@playwright/test";
import { mergeTests } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

/** The Logs page narrowed to audit events matching `q`. */
const auditLogsPath = (q: string) =>
  `/logs?type=audit&q=${encodeURIComponent(q)}`;

test.describe("Audit events on Logs", {
  tag: ["@firefox", "@webkit"],
}, () => {
  test("admin finds an audited change by its resource name and opens its event page", async ({
    adminPage,
    goToAdminPage,
    makeRandomString,
    createTeam,
    deleteTeam,
  }) => {
    // Team creation is audited (team.created), so it gives the test a
    // deterministic event tied to a unique resource name.
    const teamName = makeRandomString(10, "audit-logs");
    const team = (await (
      await createTeam(adminPage.request, teamName)
    ).json()) as { id: string };

    try {
      const eventId = await waitForAuditEvent({
        request: adminPage.request,
        resourceName: teamName,
      });

      await goToAdminPage(auditLogsPath(teamName));

      // The row names the change and the resource, never the resource id.
      const row = adminPage.getByRole("link").filter({ hasText: teamName });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(row).toContainText("Team created");
      await expect(row).not.toContainText(team.id);

      await row.click();
      await adminPage.waitForURL(`**/audit/logs/${eventId}`);
      await expect(
        adminPage.getByRole("heading", { name: "Team created" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        adminPage.getByRole("link", { name: "Back to Logs" }),
      ).toBeVisible();
    } finally {
      await deleteTeam(adminPage.request, team.id);
    }
  });

  test("an editor sees no audit events, and a member cannot open Logs or an event page", async ({
    adminPage,
    memberPage,
    editorPage,
    goToMemberPage,
    goToEditorPage,
    makeRandomString,
    createTeam,
    deleteTeam,
  }) => {
    const teamName = makeRandomString(10, "audit-logs-hidden");
    const team = (await (
      await createTeam(adminPage.request, teamName)
    ).json()) as { id: string };

    try {
      const eventId = await waitForAuditEvent({
        request: adminPage.request,
        resourceName: teamName,
      });

      // An editor reads Logs but lacks auditLog:read, so the feed leaves
      // audit events out even when the search names one.
      await goToEditorPage(auditLogsPath(teamName));
      await expect(editorPage.getByText("No events match")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        editorPage.getByRole("link").filter({ hasText: teamName }),
      ).toHaveCount(0);

      // A member holds no log permission: both pages hit the guard.
      for (const path of [auditLogsPath(teamName), `/audit/logs/${eventId}`]) {
        await goToMemberPage(path);
        await expect(
          memberPage.getByText(
            "You don't have permission to access this page.",
          ),
        ).toBeVisible({ timeout: 10_000 });
      }
    } finally {
      await deleteTeam(adminPage.request, team.id);
    }
  });
});

/**
 * The audit hook records after the response is sent, so poll the feed until
 * the event for this resource is there, and return its id.
 */
async function waitForAuditEvent(params: {
  request: APIRequestContext;
  resourceName: string;
}): Promise<string> {
  let eventId: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await params.request.get(
          `${UI_BASE_URL}/api/logs/events?sources=audit&hours=1&q=${encodeURIComponent(params.resourceName)}`,
        );
        if (!response.ok()) return undefined;
        const body = (await response.json()) as {
          data: Array<{ id: string; audit?: { resourceName: string } }>;
        };
        eventId = body.data.find(
          (event) => event.audit?.resourceName === params.resourceName,
        )?.id;
        return eventId;
      },
      { timeout: 15_000 },
    )
    .toBeDefined();
  return eventId as string;
}
