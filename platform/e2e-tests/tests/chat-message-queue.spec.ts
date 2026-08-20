import { E2eTestId } from "@archestra/shared";
import { WIREMOCK_BASE_URL } from "../consts";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
  selectApiKeyById,
  selectRuntimeModelFromDialog,
} from "../utils";
import { expect, test } from "./api-fixtures";

test.describe.configure({ retries: 2 });

const MOCK_RESPONSE = "This is a mocked response for the chat UI e2e test.";
const COMPACT_ROUTE = "**/api/chat/conversations/*/compact";

test.describe("Chat message queue", () => {
  test.setTimeout(120_000);

  // A manual /compact rewrites the thread over REST while the chat stream sits
  // idle, so nothing about it is "in flight" from the composer's point of view.
  // The composer still has to stay usable, park the message in the queue rather
  // than firing a turn at a thread that is being replaced, and send it once
  // compaction settles.
  test("queues a message typed during compaction and sends it once compaction finishes", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
  }) => {
    await expectWireMockReady();

    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });

    await goToChat(page);
    await expectChatReady(page);
    await selectApiKeyById(page, apiKeyId);

    const modelSelectorTrigger = page
      .getByTestId(E2eTestId.ChatModelSelectorTrigger)
      .or(page.getByRole("button", { name: /select model/i }))
      .first();
    await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
    await modelSelectorTrigger.click();
    await expect(
      page.getByRole("dialog", { name: "Select Model" }),
    ).toBeVisible({ timeout: 5_000 });
    await selectRuntimeModelFromDialog(page, runtimeModel);

    // Hold the compaction response open so the in-flight window is wide enough
    // to type into. The real one is a model round-trip — far longer than this.
    let releaseCompaction: (() => void) | undefined;
    const compactionHeld = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });
    await page.route(COMPACT_ROUTE, async (route) => {
      await compactionHeld;
      await route.continue();
    });

    const marker = `queue-compact-e2e-${Math.random().toString(36).slice(2, 10)}`;
    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await textarea.fill(
      `Test message ${marker} chat-ui-e2e-test: open the conversation.`,
    );
    await page.keyboard.press("Enter");
    await expect(page.getByText(MOCK_RESPONSE).first()).toBeVisible({
      timeout: 90_000,
    });

    // Kick off the manual compaction; the route above leaves it hanging.
    await textarea.fill("/compact");
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(/Compacting conversation context/).first(),
    ).toBeVisible({ timeout: 15_000 });

    // The regression: compaction used to disable the composer outright once the
    // stream had settled, so a follow-up could be neither typed nor queued.
    await expect(textarea).toBeEnabled();

    const queuedText = `queued during compaction ${marker}`;
    await textarea.fill(queuedText);
    await page.keyboard.press("Enter");

    // The message waits in the queue instead of starting a turn of its own.
    const queuedItem = page
      .getByTestId(E2eTestId.ChatMessageQueueItem)
      .filter({ hasText: queuedText });
    await expect(queuedItem).toBeVisible({ timeout: 10_000 });

    // And it keeps waiting: the drain has to hold until compaction settles, not
    // fire the moment the message lands in the queue. Without the hold the chip
    // would flash and disappear, which the assertion above alone would miss.
    await page.waitForTimeout(3_000);
    await expect(queuedItem).toBeVisible();

    releaseCompaction?.();

    // Once compaction settles the queue drains on its own: the chip goes away
    // and the message becomes a real turn in the thread.
    await expect(queuedItem).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(queuedText).first()).toBeVisible({
      timeout: 30_000,
    });
  });
});

async function expectWireMockReady() {
  try {
    const response = await fetch(`${WIREMOCK_BASE_URL}/__admin/health`);
    if (response.ok) {
      return;
    }

    throw new Error(`${response.status} ${await response.text()}`);
  } catch (error) {
    throw new Error(
      `WireMock is not reachable at ${WIREMOCK_BASE_URL}. Run tilt trigger e2e-test-dependencies before this e2e. ${String(
        error,
      )}`,
    );
  }
}
