import { UI_BASE_URL, WIREMOCK_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import { expectChatReady, goToChat } from "../utils";

const ORG_KEY_NAME = "chat-permissions-org-seed";

/**
 * Regression test for the chat-permissions fix (PR #4142).
 *
 * A user whose role grants only the slim permission set (see
 * `BASIC_USER_PERMISSION` in auth.users.setup.ts) — i.e. no
 * `canSeeProviderSettings` permission — must still be able to load /chat
 * and see the prompt textarea, instead of being stuck on the
 * "Add an LLM Provider Key" empty state.
 *
 * Pre-fix, the empty state showed because `canUseProviderSettings` was
 * gated on `canSeeProviderSettings`, which a slim role doesn't have. After
 * the fix the gate is removed and the org's provider keys load normally.
 *
 * The "Archestra Local Dev" primary key seeded by Tilt is `personal`-scoped
 * to admin and invisible to basic-user, so we explicitly seed an
 * organization-scoped OpenAI key first (validated against WireMock).
 */
test.describe("Chat permissions — slim custom role", () => {
  test.setTimeout(60_000);

  test("basic-user role can access chat without the empty-state block", async ({
    adminPage,
    basicUserPage,
  }) => {
    // Seed an org-scoped key as admin so basic-user can see at least one key.
    // Idempotent: if the key already exists from a prior run, reuse it.
    const existing = await adminPage.request.get(
      `${UI_BASE_URL}/api/llm-provider-api-keys?provider=openai`,
      { headers: { Origin: UI_BASE_URL } },
    );
    expect(existing.ok(), "list provider keys failed").toBe(true);
    const existingBody = await existing.json();
    const alreadySeeded = existingBody?.data?.some(
      (k: { name: string }) => k.name === ORG_KEY_NAME,
    );

    if (!alreadySeeded) {
      const create = await adminPage.request.post(
        `${UI_BASE_URL}/api/llm-provider-api-keys`,
        {
          data: {
            name: ORG_KEY_NAME,
            provider: "openai",
            apiKey: "sk-chat-permissions-test",
            // Route key validation through WireMock — the e2e backend's
            // ARCHESTRA_OPENAI_BASE_URL doesn't necessarily point at the
            // mock, and real OpenAI will reject the fake key with 401.
            baseUrl: `${WIREMOCK_BASE_URL}/v1`,
            scope: "org",
            isPrimary: false,
          },
          headers: { Origin: UI_BASE_URL },
        },
      );
      expect(
        create.ok(),
        `seed org-scoped key failed (${create.status()}): ${await create.text()}`,
      ).toBe(true);
    }

    await goToChat(basicUserPage);

    // The chat textarea must be reachable.
    await expectChatReady(basicUserPage);

    // The provider-key empty state must NOT be shown — that was the bug.
    await expect(
      basicUserPage.getByRole("heading", { name: /Add an LLM Provider Key/i }),
    ).not.toBeVisible();
  });
});
