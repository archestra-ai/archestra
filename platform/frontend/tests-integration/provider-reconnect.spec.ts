import {
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
} from "@archestra/shared/subscription-credentials";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

for (const kind of SUBSCRIPTION_CREDENTIAL_KINDS) {
  test(`recovery link opens and dismisses the ${kind} sign-in`, async ({
    page,
    mswControl,
  }) => {
    const definition = SUBSCRIPTION_CREDENTIALS[kind];
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [
        makeLlmProviderApiKey({
          id: `expired-${kind}`,
          provider: definition.provider,
          subscriptionKind: kind,
        }),
      ],
    });
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/api/llm-provider-api-keys") &&
        request.method() !== "GET"
      )
        writes.push(request.method());
    });
    await page.goto("/llm/model-providers");
    await expect(
      page.getByRole("heading", { name: "Model Providers", exact: true }),
    ).toBeVisible();
    await page.goto(`/llm/model-providers?reconnect=${kind}&search=kept`);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", {
        name: `Reconnect ${definition.displayName}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Sign in/ })).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await page.goForward();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/search=kept$/);
    await page.reload();
    await expect(dialog).toBeHidden();
    expect(writes).toEqual([]);
  });
}

for (const provider of ["anthropic", "bedrock"]) {
  test(`API-key recovery link opens the ${provider} form`, async ({ page }) => {
    await page.goto("/llm/model-providers");
    await page.goto(`/llm/model-providers?create=${provider}`);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Add API Key", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: "Provider", exact: true }),
    ).toContainText(provider === "bedrock" ? "Bedrock" : "Anthropic");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(dialog).toBeHidden();
    await page.goBack();
    await page.goForward();
    await expect(
      page.getByRole("heading", { name: "Model Providers", exact: true }),
    ).toBeVisible();
    await expect(dialog).toBeHidden();
  });
}
