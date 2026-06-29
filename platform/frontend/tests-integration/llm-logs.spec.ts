import {
  makeInteraction,
  makeSessionSummary,
  paginated,
} from "../src/mocks/data/interactions";
import { expect, test } from "./fixtures";

// Titles seeded by the query-aware `/api/interactions/sessions` handler in
// src/mocks/handlers.ts (one session per client/session source).
const CLAUDE_CODE_TITLE = "Claude Code session title";
const CLAUDE_DESKTOP_TITLE = "Claude Desktop session title";
const API_TITLE = "Plain API session message";

// Build an OpenAI chat-completions interaction with a specific user question
// and assistant answer so the inline conversation renders identifiable text.
function qa(
  id: string,
  question: string,
  answer: string,
  extra: Parameters<typeof makeInteraction>[0] = {},
) {
  return makeInteraction({
    id,
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: question }],
    },
    response: {
      id: `resp-${id}`,
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: { content: answer, role: "assistant" },
        },
      ],
      created: 0,
      model: "gpt-4o",
      object: "chat.completion",
    },
    ...extra,
  });
}

test.describe("LLM logs — Client (session source) filter", () => {
  // These tests rely on the query-aware `/api/interactions/sessions` handler:
  // selecting a Client option narrows the list only because the frontend sends
  // `?sessionSource=...` and the handler filters the seed on it. A frontend
  // that fails to send the param would show all sessions and fail these tests.

  test("exposes Claude Code and Claude Desktop options", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();
    await llmLogsPage.clientFilter.click();

    // Options render as buttons (not role="option") and carry the Anthropic
    // logo's alt text alongside the label, so match the label as a substring.
    await expect(
      page.getByRole("button", { name: "Claude Code" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Claude Desktop" }),
    ).toBeVisible();
  });

  test("narrows the list to Claude Code and reflects it in the URL, then clears", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();
    await expect(llmLogsPage.rowForText(API_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toBeVisible();

    await llmLogsPage.selectClient("Claude Code");

    await expect(page).toHaveURL(/sessionSource=claude_code/);
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(API_TITLE)).toHaveCount(0);
    await expect(llmLogsPage.rowForText(CLAUDE_DESKTOP_TITLE)).toHaveCount(0);

    // Clearing back to "All Clients" drops the param and restores the list.
    await llmLogsPage.selectClient("All Clients");

    await expect(page).not.toHaveURL(/sessionSource=/);
    await expect(llmLogsPage.rowForText(API_TITLE)).toBeVisible();
  });

  test("narrows the list to Claude Desktop", async ({ page, llmLogsPage }) => {
    await llmLogsPage.goto();
    await expect(llmLogsPage.rowForText(CLAUDE_DESKTOP_TITLE)).toBeVisible();

    await llmLogsPage.selectClient("Claude Desktop");

    await expect(page).toHaveURL(/sessionSource=claude_desktop/);
    await expect(llmLogsPage.rowForText(CLAUDE_DESKTOP_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toHaveCount(0);
    await expect(llmLogsPage.rowForText(API_TITLE)).toHaveCount(0);
  });

  test("coexists with the Source filter (both params in the URL)", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();

    // Source filter is the 3rd combobox; pick "API" (options are buttons).
    await page.getByRole("combobox").nth(2).click();
    await page.getByRole("button", { name: "API", exact: true }).click();
    await expect(page).toHaveURL(/source=api/);

    await llmLogsPage.selectClient("Claude Code");

    await expect(page).toHaveURL(/source=api/);
    await expect(page).toHaveURL(/sessionSource=claude_code/);
    // Both filters applied: only the Claude Code (source=api) session remains.
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(API_TITLE)).toHaveCount(0);
  });
});

test.describe("LLM logs — session detail inline conversation", () => {
  test("renders the latest conversation above the interactions table and drops the View button", async ({
    page,
    llmLogsPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/interactions",
      body: paginated([makeInteraction({ id: "i1", sessionId: "s1" })]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/sessions",
      body: paginated([makeSessionSummary({ sessionId: "s1" })]),
    });

    await llmLogsPage.gotoSession("s1");

    await expect(llmLogsPage.latestConversationHeading).toBeVisible();
    // Assistant answer only appears in the conversation (not the table).
    await expect(
      page.getByText("The capital of France is Paris."),
    ).toBeVisible();

    // The conversation block sits above the interactions table.
    const headingBox =
      await llmLogsPage.latestConversationHeading.boundingBox();
    const tableBox = await llmLogsPage.table.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(tableBox).not.toBeNull();
    expect(headingBox?.y ?? 0).toBeLessThan(tableBox?.y ?? 0);

    // The old "View" affordance is gone.
    await expect(
      page.getByRole("link", { name: "View", exact: true }),
    ).toHaveCount(0);
  });

  test("shows the latest MAIN interaction when the session mixes main and subagent requests", async ({
    page,
    llmLogsPage,
    mswControl,
  }) => {
    // Sorted desc: the subagent request is newer, the main request older.
    await mswControl.use({
      method: "get",
      url: "/api/interactions",
      body: paginated([
        qa("sub", "Subagent question", "Subagent answer", {
          requestType: "subagent",
        }),
        qa("main", "Main question", "Main answer", { requestType: "main" }),
      ]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/sessions",
      body: paginated([makeSessionSummary({ sessionId: "s2" })]),
    });

    await llmLogsPage.gotoSession("s2");

    await expect(llmLogsPage.latestConversationHeading).toBeVisible();
    // The main interaction's assistant answer renders...
    await expect(page.getByText("Main answer")).toBeVisible();
    // ...and the subagent's assistant answer does not (its thread isn't shown).
    await expect(page.getByText("Subagent answer")).toHaveCount(0);
  });

  test("omits the conversation block and shows the empty state for a session with no interactions", async ({
    page,
    llmLogsPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/interactions",
      body: paginated([]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/sessions",
      body: paginated([makeSessionSummary({ sessionId: "s3" })]),
    });

    await llmLogsPage.gotoSession("s3");

    await expect(
      page.getByText("No interactions found for this session"),
    ).toBeVisible();
    await expect(llmLogsPage.latestConversationHeading).toHaveCount(0);
  });
});
