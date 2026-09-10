import { mergeTests } from "@playwright/test";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

test("Cursor install link follows the selected gateway in manual setup", async ({
  page,
  request,
  goToPage,
  createMcpGateway,
  deleteAgent,
  makeRandomString,
}) => {
  const name = makeRandomString(8, "Cursor Tools & Reports");
  const response = await createMcpGateway(request, name, "org");
  const gateway = await response.json();
  try {
    await goToPage(page, `/connection?gatewayId=${gateway.id}`);
    await page.getByRole("button", { name: "Other ways to connect" }).click();
    await page
      .getByRole("button", {
        name: "Cursor logo Cursor AI code editor",
        exact: true,
      })
      .click();
    const install = page.getByRole("link", { name: "Add to Cursor" });
    await expect(install).toBeVisible();
    const href = await install.getAttribute("href");
    const link = new URL(href ?? "");
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install",
    );
    expect(link.searchParams.get("name")).toBe(
      name.toLowerCase().replace(/\s+/g, "_"),
    );
    const config = JSON.parse(
      Buffer.from(link.searchParams.get("config") ?? "", "base64").toString(
        "utf8",
      ),
    );
    expect(Object.keys(config)).toEqual(["url"]);
    expect(new URL(config.url).pathname).toBe(`/v1/mcp/${gateway.slug}`);
    await expect(page.getByTestId("connect-command-status")).toHaveText(
      "Setup command ready",
    );
    const fullSetup = page.getByText(
      "Run this command to apply the full setup reviewed above.",
      { exact: false },
    );
    await expect(fullSetup).not.toBeVisible();
    await page
      .getByText("Set up proxy, skills, and plugins", { exact: true })
      .click();
    await expect(fullSetup).toBeVisible();
    await page
      .getByRole("button", {
        name: "Claude Code logo Claude Code Anthropic CLI",
        exact: true,
      })
      .click();
    await expect(install).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Cursor logo Cursor AI code editor",
        exact: true,
      })
      .click();
    await expect(install).toHaveAttribute("href", href ?? "");
  } finally {
    await deleteAgent(request, gateway.id);
  }
});
