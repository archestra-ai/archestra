import {
  E2eTestId,
  ENGINEERING_TEAM_NAME,
  getE2eRequestUrl,
  UI_BASE_URL,
} from "../consts";
import { expect, test } from "../fixtures";
import { goToMcpRegistry } from "../utils";

/**
 * Promotion story: an Editor (who holds mcpRegistry:team-admin and is a member
 * of the Engineering team) creates a personal catalog item and then promotes it
 * to their team via the registry's edit form — the team-scoping capability
 * shipped for non-admin editors.
 */
test.describe("MCP Catalog promotion", () => {
  test("an editor promotes their own personal catalog item to a team they belong to", async ({
    editorPage,
    makeRandomString,
  }) => {
    const name = makeRandomString(6, "promote-src");

    // The editor creates a personal catalog item (setup, via the editor's
    // own authenticated request context).
    const createResponse = await editorPage.request.post(
      getE2eRequestUrl("/api/internal_mcp_catalog"),
      {
        headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
        data: {
          name,
          description: "promotion story e2e",
          serverType: "remote",
          serverUrl: "https://example.test/mcp",
          scope: "personal",
        },
      },
    );
    expect(createResponse.ok()).toBeTruthy();
    const created = await createResponse.json();
    expect(created.scope).toBe("personal");

    // The editor promotes it to the Engineering team through the edit form.
    await goToMcpRegistry(editorPage);
    await editorPage
      .getByTestId(`${E2eTestId.McpServerSettingsButton}-${name}`)
      .click();

    const settingsDialog = editorPage.getByRole("dialog", {
      name: new RegExp(`${name} Settings`, "i"),
    });
    await expect(settingsDialog).toBeVisible({ timeout: 30_000 });

    // Switch visibility Personal -> Teams. The visibility selector renders
    // collapsed (showing only the current Personal option), so expand it
    // first; the Teams option's description is unique within the expanded
    // list, so match on it.
    await settingsDialog
      .getByRole("button", { name: /Only you can access this MCP server/i })
      .click();
    await settingsDialog
      .getByRole("button", {
        name: /Share this MCP server with selected teams/i,
      })
      .click();

    // Pick the Engineering team (the editor is a member of it).
    await settingsDialog.getByPlaceholder("Select teams...").click();
    await editorPage
      .getByRole("option", { name: ENGINEERING_TEAM_NAME })
      .click();

    await settingsDialog.getByRole("button", { name: /Save Changes/i }).click();

    // The item is now team-scoped and assigned to Engineering.
    await expect
      .poll(
        async () => {
          const res = await editorPage.request.get(
            getE2eRequestUrl(`/api/internal_mcp_catalog/${created.id}`),
            { headers: { Origin: UI_BASE_URL } },
          );
          if (!res.ok()) return null;
          const item = await res.json();
          return {
            scope: item.scope,
            teams: (item.teams ?? []).map((t: { name: string }) => t.name),
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ scope: "team", teams: [ENGINEERING_TEAM_NAME] });
  });
});
