import {
  makeInteraction,
  makeSessionSummary,
  paginated,
} from "../src/mocks/data/interactions";
import { expect, test } from "./fixtures";

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

test.describe("LLM logs — session detail inline conversation", () => {
  test("shows the latest conversation in the details pane under the request list", async ({
    page,
    llmLogsPage,
    mswControl,
  }) => {
    const interaction = makeInteraction({ id: "i1", sessionId: "s1" });
    await mswControl.use({
      method: "get",
      url: "/api/llm-proxy-logs/summaries",
      body: paginated([interaction]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-proxy-logs/sessions",
      body: paginated([
        makeSessionSummary({ sessionId: "s1", lastInteractionId: "i1" }),
      ]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-proxy-logs/i1",
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
      url: "/api/llm-proxy-logs/summaries",
      body: paginated([subagentInteraction, mainInteraction]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-proxy-logs/sessions",
      body: paginated([
        makeSessionSummary({
          sessionId: "s2",
          lastInteractionId: "main",
        }),
      ]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-proxy-logs/main",
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
      url: "/api/llm-proxy-logs/summaries",
      body: paginated([]),
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-proxy-logs/sessions",
      body: paginated([makeSessionSummary({ sessionId: "s3" })]),
    });

    await llmLogsPage.gotoSession("s3");

    await expect(
      page.getByText("No requests recorded for this session yet."),
    ).toBeVisible();
    await expect(llmLogsPage.conversationPane).toHaveCount(0);
  });
});
