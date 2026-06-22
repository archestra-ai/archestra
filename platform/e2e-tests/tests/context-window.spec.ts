import { E2eTestId } from "@archestra/shared";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
  selectApiKeyById,
  selectRuntimeModelFromDialog,
  sendChatMessage,
} from "../utils";
import { expect, test } from "./api-fixtures";

// Run serially to avoid WireMock stub contention with the main chat suite.
test.describe.configure({ mode: "serial", retries: 2 });

test.describe("Context window visualizer", () => {
  test.setTimeout(120_000);

  test("opens the context window panel after a turn and shows category rows", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
  }) => {
    // Provision a WireMock-backed Anthropic key so the chat backend can stream
    // a real breakdown event without hitting a live LLM.
    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });

    await goToChat(page);
    await expectChatReady(page);

    await selectApiKeyById(page, apiKeyId);

    // Pick the WireMock model so the model-selector dropdown closes cleanly.
    const modelSelectorTrigger = page
      .getByTestId(E2eTestId.ChatModelSelectorTrigger)
      .or(page.getByRole("button", { name: /select model/i }))
      .or(page.getByRole("button", { name: /claude|gpt|gemini/i }))
      .first();
    await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
    await modelSelectorTrigger.click();
    await expect(
      page.getByRole("dialog", { name: "Select Model" }),
    ).toBeVisible({ timeout: 5_000 });
    await selectRuntimeModelFromDialog(page, runtimeModel);

    // Send a message and wait for the assistant turn to finish — the breakdown
    // is streamed once per turn at assembly time, right before the model call.
    const testMessageId = `context-window-e2e-${Math.random().toString(36).slice(2, 10)}`;
    await sendChatMessage(
      page,
      `Test message ${testMessageId} chat-ui-e2e-test: show context window.`,
    );

    // Wait for the assistant response to confirm the turn completed and the
    // breakdown event had time to land in client state.
    await expect(
      page.getByText("This is a mocked response for the chat UI e2e test."),
    ).toBeVisible({ timeout: 90_000 });

    // The context indicator ring appears only when the backend has emitted a
    // breakdown (tokensUsed > 0 and maxTokens are known). It may not appear
    // immediately after the first message; poll for it.
    const trigger = page.getByTestId(E2eTestId.ChatContextUsageTrigger);
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // Click the ring to open the modal.
    await trigger.click();

    // The dialog should open and the panel body should be present.
    const dialog = page.getByRole("dialog", { name: "Context window" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const panel = page.getByTestId(E2eTestId.ChatContextUsagePanel);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // At least one category gauge row must be present — the exact set depends on
    // what the WireMock Anthropic model returns in the breakdown, but "Messages"
    // is always populated after one conversation turn.
    await expect(panel.getByText("Messages")).toBeVisible({ timeout: 5_000 });

    // The estimate footnote is always rendered at the bottom of the panel.
    await expect(panel.getByText(/Estimated before sending/)).toBeVisible({
      timeout: 5_000,
    });
  });
});
