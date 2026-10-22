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
const OPENCODE_TITLE = "OpenCode proxy session";
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

test.describe("LLM logs — Client filter", () => {
  // These tests rely on the query-aware `/api/interactions/sessions` handler:
  // selecting a Client option narrows the list only because the frontend sends
  // `?client=...` and the handler filters the seed by external_agent_id. A
  // frontend that fails to send the param would show all sessions and fail these.
  // Code and Desktop must remain independently selectable.

  test("exposes distinct coding client options", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();
    await llmLogsPage.clientFilter.click();

    // Options carry the Anthropic
    // logo's alt text alongside the label, so match the label as a substring.
    await expect(
      page.getByRole("option", { name: "Claude Code" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Claude Desktop" }),
    ).toBeVisible();
    await expect(page.getByRole("option", { name: "OpenCode" })).toBeVisible();
    await expect(page.getByRole("option")).toHaveText([
      "All Clients",
      "Claude Code",
      "Claude Desktop",
      "Cursor",
      "Codex",
      "OpenCode",
      "Kilo Code",
      "Copilot CLI",
    ]);
  });

  test("narrows the list to OpenCode traffic and reflects it in the URL", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();

    await llmLogsPage.selectClient("OpenCode");

    await expect(page).toHaveURL(/client=opencode/);
    await expect(llmLogsPage.rowForText(OPENCODE_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toHaveCount(0);
    await expect(llmLogsPage.rowForText(API_TITLE)).toHaveCount(0);
  });

  test("narrows the list to Claude clients and reflects it in the URL, then clears", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();
    await expect(llmLogsPage.rowForText(API_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toBeVisible();

    await llmLogsPage.selectClient("Claude Code");

    await expect(page).toHaveURL(/client=claude-code/);
    // Only Code remains; Desktop and plain API traffic are excluded.
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_DESKTOP_TITLE)).toHaveCount(0);
    await expect(llmLogsPage.rowForText(API_TITLE)).toHaveCount(0);

    await llmLogsPage.selectClient("Claude Desktop");
    await expect(page).toHaveURL(/client=claude-desktop/);
    await expect(llmLogsPage.rowForText(CLAUDE_DESKTOP_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toHaveCount(0);

    // Clearing back to "All Clients" drops the param and restores the list.
    await llmLogsPage.selectClient("All Clients");

    await expect(page).not.toHaveURL(/client=/);
    await expect(llmLogsPage.rowForText(API_TITLE)).toBeVisible();
  });

  test("coexists with the Source filter (both params in the URL)", async ({
    page,
    llmLogsPage,
  }) => {
    await llmLogsPage.goto();

    // Source filter is the 3rd combobox; pick "API".
    await page.getByRole("combobox").nth(2).click();
    await page.getByRole("option", { name: "API", exact: true }).click();
    await expect(page).toHaveURL(/source=api/);

    await llmLogsPage.selectClient("Claude Code");

    await expect(page).toHaveURL(/source=api/);
    await expect(page).toHaveURL(/client=claude-code/);
    // Both filters applied: only the Claude session whose source is API remains
    // (the Desktop seed uses a non-api source, the API seed is not a Claude client).
    await expect(llmLogsPage.rowForText(CLAUDE_CODE_TITLE)).toBeVisible();
    await expect(llmLogsPage.rowForText(CLAUDE_DESKTOP_TITLE)).toHaveCount(0);
    await expect(llmLogsPage.rowForText(API_TITLE)).toHaveCount(0);
  });
});

test.describe("LLM logs — session detail inline conversation", () => {
  test("shows the latest conversation in the details pane under the request list", async ({
    page,
    llmLogsPage,
    mswControl,
  }) => {
    const interaction = makeInteraction({ id: "i1", sessionId: "s1" });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/summaries",
      body: paginated([interaction]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/sessions",
      body: paginated([
        makeSessionSummary({ sessionId: "s1", lastInteractionId: "i1" }),
      ]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/i1",
      body: interaction,
    });

    await llmLogsPage.gotoSession("s1");

    // The latest request is selected, and its answer only appears in the
    // conversation (the list carries no message text).
    await expect(
      llmLogsPage.requestList.getByRole("button", { name: /^Test Agent, / }),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      llmLogsPage.conversationPane.getByText("The capital of France is Paris."),
    ).toBeVisible();

    // The details sit below the request list they describe.
    const listBox = await llmLogsPage.requestList.boundingBox();
    const conversationBox = await llmLogsPage.conversationPane.boundingBox();
    expect(listBox).not.toBeNull();
    expect(conversationBox).not.toBeNull();
    expect(listBox?.y ?? 0).toBeLessThan(conversationBox?.y ?? 0);

    // The old "View" affordance is gone.
    await expect(
      page.getByRole("link", { name: "View", exact: true }),
    ).toHaveCount(0);
  });

  test("shows the latest MAIN interaction when the session mixes main and subagent requests", async ({
    llmLogsPage,
    mswControl,
  }) => {
    // Sorted desc: the subagent request is newer, the main request older.
    const subagentInteraction = qa(
      "sub",
      "Subagent question",
      "Subagent answer",
      { requestType: "subagent" },
    );
    const mainInteraction = qa("main", "Main question", "Main answer", {
      requestType: "main",
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/summaries",
      body: paginated([subagentInteraction, mainInteraction]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/sessions",
      body: paginated([
        makeSessionSummary({
          sessionId: "s2",
          lastInteractionId: "main",
        }),
      ]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/main",
      body: mainInteraction,
    });

    await llmLogsPage.gotoSession("s2");

    // The main interaction's assistant answer renders...
    await expect(
      llmLogsPage.conversationPane.getByText("Main answer"),
    ).toBeVisible();
    // ...and the subagent's assistant answer does not (its thread isn't shown).
    await expect(llmLogsPage.page.getByText("Subagent answer")).toHaveCount(0);
    await expect(
      llmLogsPage.requestList.getByRole("button", { name: /^Sub-agent, / }),
    ).toBeVisible();
    await expect(
      llmLogsPage.requestList.getByRole("button", { name: /^Test Agent, / }),
    ).toBeVisible();
  });

  test("omits the conversation and shows the empty state for a session with no interactions", async ({
    page,
    llmLogsPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/interactions/summaries",
      body: paginated([]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/interactions/sessions",
      body: paginated([makeSessionSummary({ sessionId: "s3" })]),
    });

    await llmLogsPage.gotoSession("s3");

    await expect(
      page.getByText("No requests recorded for this session yet."),
    ).toBeVisible();
    await expect(llmLogsPage.conversationPane).toHaveCount(0);
  });
});
