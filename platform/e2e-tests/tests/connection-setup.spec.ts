import { expect } from "@playwright/test";
import { API_BASE_URL } from "../consts";
import { test } from "../fixtures";

/**
 * /connection one-command setup flow for script-capable clients
 * (Claude Code / Codex / Copilot CLI / Cursor) and the unchanged manual
 * flow for n8n.
 */
test.describe("connection one-command setup", () => {
  test("claude-code wizard generates a one-time curl|bash command", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/connection?clientId=claude-code");

    // selection-only steps: no static-token tab, no command dumps
    await expect(
      page.getByText("Run one command to connect everything"),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /Static token/i })).toHaveCount(
      0,
    );

    const generate = page.getByTestId("connect-generate-command");
    await expect(generate).toBeEnabled();
    await generate.click();

    // the one-liner appears, pointing at the script endpoint
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

    // regenerating produces a fresh working command
    await page.getByTestId("connect-regenerate-command").click();
    await expect(
      page.getByText(/curl -fsSL '.*\/api\/connection-setups\//),
    ).toBeVisible();
  });

  test("proxy auth tabs switch between passthrough and virtual key", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/connection?clientId=claude-code");

    await expect(
      page.getByRole("tab", { name: /Your provider key/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/you keep using your own API key or login/i),
    ).toBeVisible();

    await page.getByRole("tab", { name: /Virtual key/i }).click();
    await expect(
      page.getByText(/virtual key created for you/i).first(),
    ).toBeVisible();
  });

  test("n8n keeps the manual step-by-step flow", async ({ page, goToPage }) => {
    await goToPage(page, "/connection?clientId=n8n");

    // manual flow: auth method tabs and step-by-step instructions remain
    await expect(
      page.getByText('Add the "MCP Client Tool" node'),
    ).toBeVisible();
    // no one-command step for non-script clients
    await expect(
      page.getByText("Run one command to connect everything"),
    ).toHaveCount(0);
  });
});
