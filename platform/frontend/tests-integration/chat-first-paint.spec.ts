import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

test("keeps drafts editable and sending disabled while the compact chat roster loads", async ({
  page,
  mswControl,
}) => {
  const key = makeLlmProviderApiKey({ bestModelId: "model-1" });
  const agent = makeAgent({ modelId: "model-1", llmApiKeyId: key.id });
  const model = {
    dbId: "model-1",
    id: "claude-test",
    displayName: "Test model",
    provider: "anthropic",
    isFree: false,
    isBest: true,
  };
  await mswControl.registerMany([
    { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
    { method: "get", url: "/api/agents/chat-roster", body: [agent] },
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    { method: "get", url: "/api/llm-models/available", body: [model] },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: model.dbId, chatApiKeyId: key.id },
    },
  ]);
  await page.goto("/chat");
  const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
  await expect(textarea).toBeEditable();
  await textarea.fill("Draft while ready");
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => sessionStorage.clear());
  await mswControl.use({
    method: "get",
    url: "/api/agents/chat-roster",
    body: [agent],
    delayMs: 60_000,
  });
  await page.reload({ waitUntil: "commit" });
  await expect(textarea).toBeEditable();
  await textarea.fill("Draft before the roster arrives");
  await expect(textarea).toHaveValue("Draft before the roster arrives");
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("No agents yet")).toHaveCount(0);
});
