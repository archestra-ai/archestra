import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { BrowserContext, Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import { sessionSeed } from "../src/mocks/data/auth";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

// The app renders its shell and the chat composer on a session cookie, before
// get-session answers (see WithAuthCheck). These specs pin what happens with a
// valid cookie, an expired one, and none. The MSW frontend mounts the app only
// after the mock worker starts, so they cover the client side of it; the
// server-rendered composer is covered by the production measurement.

const SIGNED_OUT_ERROR = {
  error: { message: "Unauthenticated", type: "api_authentication_error" },
};

async function setSessionCookie(context: BrowserContext, baseURL: string) {
  await context.addCookies([
    {
      name: "archestra.session_token",
      value: "test-session-token",
      url: baseURL,
    },
  ]);
}

/** Every error toast that appears from now on. */
function watchErrorToasts(page: Page) {
  const seen: string[] = [];
  void page.exposeFunction("__recordToast", (text: string) => seen.push(text));
  void page.addInitScript(() => {
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll(
        "[data-sonner-toast][data-type=error]",
      )) {
        const text = toast.textContent ?? "";
        if (!toast.hasAttribute("data-recorded")) {
          toast.setAttribute("data-recorded", "");
          (
            window as unknown as { __recordToast: (t: string) => void }
          ).__recordToast(text);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return seen;
}

test("with a session cookie the composer takes input before get-session answers", async ({
  page,
  context,
  baseURL,
  mswControl,
}) => {
  const key = makeLlmProviderApiKey({ provider: "openai" });
  const agent = makeAgent({ llmApiKeyId: key.id });
  await setSessionCookie(context, baseURL as string);
  await mswControl.registerMany([
    { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    { method: "get", url: "/api/agents/chat-roster", body: [agent] },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: null, chatApiKeyId: null },
    },
  ]);
  // Hold get-session long enough that only an optimistic shell can show the
  // composer in the meantime.
  await mswControl.use({
    method: "get",
    url: "/api/auth/get-session",
    body: sessionSeed,
    delayMs: 8_000,
  });
  let sessionAnswered = false;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/auth/get-session")
      sessionAnswered = true;
  });

  await page.goto("/chat");
  const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
  await expect(textarea).toBeEditable({ timeout: 7_000 });
  await textarea.fill("Typed while the session check runs");
  expect(sessionAnswered).toBe(false);
  await expect(textarea).toHaveValue("Typed while the session check runs");
  // The session then confirms and the app stays.
  await expect.poll(() => sessionAnswered, { timeout: 15_000 }).toBe(true);
  await expect(textarea).toHaveValue("Typed while the session check runs");
  await expect(page).toHaveURL(/\/chat$/);
});

test("an expired session cookie goes to sign-in without error toasts or data", async ({
  page,
  context,
  baseURL,
  mswControl,
}) => {
  await setSessionCookie(context, baseURL as string);
  const toasts = watchErrorToasts(page);
  await mswControl.registerMany([
    // The cookie is no longer valid: the session check says nobody is signed
    // in, and every data endpoint refuses.
    {
      method: "get",
      url: "/api/auth/get-session",
      body: null,
      delayMs: 1_500,
    },
    {
      method: "get",
      url: "/api/bootstrap",
      status: 401,
      body: SIGNED_OUT_ERROR,
    },
    {
      method: "get",
      url: "/api/chat/conversations",
      status: 401,
      body: SIGNED_OUT_ERROR,
    },
    {
      method: "get",
      url: "/api/members/default-agent",
      status: 401,
      body: SIGNED_OUT_ERROR,
    },
    {
      method: "get",
      url: "/api/members/default-model",
      status: 401,
      body: SIGNED_OUT_ERROR,
    },
  ]);

  await page.goto("/chat");
  // The optimistic shell shows the composer while the session check runs…
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeVisible();
  // …and gives way to sign-in once it says there is no user.
  await expect(page).toHaveURL(/\/auth\/sign-in\?redirectTo=%2Fchat/, {
    timeout: 20_000,
  });
  expect(toasts).toEqual([]);
});

test("without a session cookie the visitor goes straight to sign-in", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/auth/get-session",
    body: null,
  });
  // Recorded from the first frame, so a composer flashed before the redirect
  // would be caught too.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector("[data-testid=chat-prompt-textarea]"))
        (window as unknown as { __composerSeen: boolean }).__composerSeen =
          true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/auth\/sign-in/, { timeout: 20_000 });
  expect(
    await page.evaluate(
      () => (window as unknown as { __composerSeen?: boolean }).__composerSeen,
    ),
  ).toBeUndefined();
});

test("a send before the agent resolves waits, keeping the text", async ({
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
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    { method: "get", url: "/api/llm-models/available", body: [model] },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: model.dbId, chatApiKeyId: key.id },
    },
    {
      method: "get",
      url: "/api/agents/chat-roster",
      body: [agent],
      delayMs: 6_000,
    },
  ]);

  await page.goto("/chat");
  const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
  await expect(textarea).toBeEditable();
  await textarea.fill("Send me when the agent is known");
  // Sending waits for the agent (the chip's placeholder is a unit test).
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  await expect(submit).toBeDisabled();
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("Send me when the agent is known");

  // Once the roster answers, the same draft can be sent.
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await expect(textarea).toHaveValue("Send me when the agent is known");
});
