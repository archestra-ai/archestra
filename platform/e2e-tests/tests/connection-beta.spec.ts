import { expect } from "@playwright/test";
import { API_BASE_URL } from "../consts";
import { test } from "../fixtures";

/**
 * /connection_beta — the new step-by-step wizard for script-capable clients
 * (Claude Code / Codex / Copilot CLI / Cursor) and the manual flow for n8n.
 * The command auto-generates — there is no generate button.
 */
test.describe("connection_beta wizard", () => {
  test("the wizard auto-generates a one-time curl|bash command", async ({
    page,
    goToPage,
  }) => {
    // no clientId: the wizard preselects the first visible client and the
    // command appears without any clicks
    await goToPage(page, "/connection_beta");

    const command = page.getByText(/curl -fsSL '.*\/api\/connection-setups\//);
    await expect(command).toBeVisible();
    const commandText = (await command.textContent()) ?? "";
    const url = commandText.match(/curl -fsSL '([^']+)'/)?.[1];
    expect(url).toBeTruthy();

    // first fetch returns a bash script with no placeholders…
    const scriptUrl = (url as string).replace(
      /^https?:\/\/[^/]+/,
      API_BASE_URL,
    );
    const first = await page.request.get(scriptUrl);
    expect(first.status()).toBe(200);
    expect(first.headers()["content-type"]).toContain("text/plain");
    const script = await first.text();
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toContain("archestra_TOKEN");
    expect(script).not.toMatch(/<your-[a-z-]+-api-key>/);

    // …and the token is one-time: the second fetch is refused
    const second = await page.request.get(scriptUrl);
    expect(second.status()).toBe(410);

    // regenerating produces a fresh command with a new token
    await page.getByTestId("connect-regenerate-command").click();
    await expect(
      page.getByText(/curl -fsSL '.*\/api\/connection-setups\//),
    ).not.toHaveText(commandText);
  });

  test("provider and auth choices live behind tabs and inline editors", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/connection_beta?clientId=claude-code");

    // claude-code supports two providers — rendered as flat tabs on the block
    await expect(page.getByRole("button", { name: "Anthropic" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "AWS Bedrock" }),
    ).toBeVisible();

    // auth mode is changed inline from the proxy line, passthrough by default
    await page.getByTestId("connect-change-proxy").click();
    await expect(
      page.getByRole("tab", { name: /Your provider key/i }),
    ).toBeVisible();
    await expect(page.getByText(/your own API key or/i)).toBeVisible();

    // switching to a virtual key updates the proxy summary line
    await page.getByRole("tab", { name: /Virtual key/i }).click();
    await expect(page.getByText("a virtual key").first()).toBeVisible();
  });

  test("switching the platform to Windows yields a PowerShell command", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/connection_beta?clientId=claude-code");

    // defaults to a curl|bash command (macOS/Linux)
    await expect(
      page.getByText(/curl -fsSL '.*\/api\/connection-setups\//),
    ).toBeVisible();

    // open the platform editor in the review step and pick Windows
    await page.getByTestId("connect-change-platform").click();
    await page.getByTestId("connect-platform-select").click();
    await page.getByRole("option", { name: "Windows" }).click();

    // the command regenerates as a PowerShell irm|iex one-liner, and the
    // served script is PowerShell rather than bash
    const command = page.getByText(
      /irm '.*\/api\/connection-setups\/.*' \| iex/,
    );
    await expect(command).toBeVisible();
    const commandText = (await command.textContent()) ?? "";
    const url = commandText.match(/irm '([^']+)'/)?.[1];
    expect(url).toBeTruthy();

    const scriptUrl = (url as string).replace(
      /^https?:\/\/[^/]+/,
      API_BASE_URL,
    );
    const script = await (await page.request.get(scriptUrl)).text();
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).not.toContain("#!/usr/bin/env bash");
  });

  test("admins configure the page from a dialog on the page itself", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/connection_beta");

    // the fixture user is an admin, so the settings entry point is visible
    await page.getByTestId("connect-page-settings").click();
    await expect(
      page.getByRole("dialog", { name: /Connect page settings/i }),
    ).toBeVisible();
    await expect(page.getByText("Default MCP Gateway")).toBeVisible();
  });

  test("n8n keeps the manual step-by-step flow", async ({ page, goToPage }) => {
    await goToPage(page, "/connection_beta?clientId=n8n");

    // manual flow: step-by-step instructions remain, no auto-generated command
    await expect(
      page.getByText('Add the "MCP Client Tool" node'),
    ).toBeVisible();
    await expect(page.getByText(/curl -fsSL/)).toHaveCount(0);
  });
});
