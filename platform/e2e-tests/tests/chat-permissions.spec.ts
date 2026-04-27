import { expect, test } from "../fixtures";
import { expectChatReady, goToChat } from "../utils";

/**
 * Regression test for the chat-permissions fix (PR #4142).
 *
 * A user whose role grants only the slim permission set
 * (agent:read, llmProviderApiKey:read, llmModel:read) — i.e. no
 * `canSeeProviderSettings` permission — must still be able to load /chat
 * and see the prompt textarea, instead of being stuck on the
 * "Add an LLM Provider Key" empty state.
 */
test.describe("Chat permissions — slim custom role", () => {
  test.setTimeout(60_000);

  test("basic-user role can access chat without the empty-state block", async ({
    basicUserPage,
  }) => {
    await goToChat(basicUserPage);

    // The chat textarea must be reachable.
    await expectChatReady(basicUserPage);

    // The provider-key empty state must NOT be shown — that was the bug.
    await expect(
      basicUserPage.getByRole("heading", { name: /Add an LLM Provider Key/i }),
    ).not.toBeVisible();
  });
});
