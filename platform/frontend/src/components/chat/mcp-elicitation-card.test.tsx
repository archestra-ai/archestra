import { ASK_USER_OTHER_ANSWER_FIELD } from "@archestra/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserGroupMember } from "./ask-user-outcome";
import { McpElicitationCard } from "./mcp-elicitation-card";
import {
  type ChatMcpElicitationRequest,
  isChoiceElicitationRequest,
} from "./mcp-elicitation-fields";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000100";

describe("McpElicitationCard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a single question on the click itself, with no Submit, header, tabs or navigation", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);

    render(
      <McpElicitationCard
        requests={[
          singleChoice({
            id: "q-1",
            message: "Accept this change for the rest of this session?",
            options: ["Accept for this session", "Do not accept"],
          }),
        ]}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByTestId("mcp-elicitation-card")).toBeInTheDocument();
    expect(
      screen.getByText("Accept this change for the rest of this session?"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-elicitation-next"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-elicitation-back"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("1 of 1", { exact: false }),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Submit" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Accept for this session" }),
    );

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      id: "q-1",
      action: "accept",
      content: { choice: "Accept for this session" },
    });
  });

  it("renders an OpenAPPA review as a collapsed tool card and submits approval from Approve", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    const request = openappaReview();

    expect(isChoiceElicitationRequest(request)).toBe(true);
    render(<McpElicitationCard requests={[request]} onRespond={onRespond} />);

    const card = screen.getByTestId("mcp-elicitation-card");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("archestra__todo_write")).toBeInTheDocument();
    expect(screen.getByText("Approval requested")).toBeInTheDocument();
    // Arguments stay collapsed until the header opens them.
    expect(screen.queryByText(/qa-hitl/)).not.toBeInTheDocument();
    await user.click(screen.getByText("archestra__todo_write"));
    expect(screen.getByText(/qa-hitl/)).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/\\"/);

    expect(card).not.toHaveTextContent("APPA asks you to rule");
    expect(card).not.toHaveTextContent("What this ruling would cover");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Submit" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(onRespond).toHaveBeenCalledExactlyOnceWith({
      id: "review-1",
      action: "accept",
      content: { action: "approve" },
    });
  });

  it("submits an all-optional multi-choice question with nothing checked", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);

    render(
      <McpElicitationCard
        requests={[
          multiChoice({
            id: "q-1",
            message: "Which steps should run?",
            options: ["Run tests", "Deploy"],
          }),
        ]}
        onRespond={onRespond}
      />,
    );

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onRespond).toHaveBeenCalledWith({
      id: "q-1",
      action: "accept",
      content: { option_0: false, option_1: false },
    });
  });

  it("walks through questions as tabs and submits one answer per question from the last tab", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);

    render(
      <McpElicitationCard
        requests={[
          singleChoice({
            id: "q-visibility",
            header: "Visibility",
            message: "Who should see the app?",
            options: ["Only me", "My team"],
          }),
          singleChoice({
            id: "q-region",
            message: "Where should it run?",
            options: ["EU", "US"],
          }),
        ]}
        onRespond={onRespond}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(screen.getByText("1 of 2", { exact: false })).toBeInTheDocument();
    expect(tabs).toHaveLength(2);
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveTextContent(
      "Visibility",
    );
    // No header: a positional fallback label.
    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveTextContent(
      "Question 2",
    );
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // First tab: navigation only.
    expect(screen.getByTestId("mcp-elicitation-next")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-elicitation-back"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-elicitation-submit"),
    ).not.toBeInTheDocument();

    // Picking an option only selects it; Next moves on.
    await user.click(screen.getByRole("radio", { name: "My team" }));
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveTextContent(
      "(answered)",
    );
    expect(screen.getByText("Where should it run?")).toBeInTheDocument();
    expect(screen.getByText("2 of 2", { exact: false })).toBeInTheDocument();

    // Last tab: Back and Submit, no Next.
    expect(screen.getByTestId("mcp-elicitation-back")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-elicitation-next"),
    ).not.toBeInTheDocument();
    const submit = screen.getByTestId("mcp-elicitation-submit");
    expect(submit).toBeDisabled();

    // The last tab never auto-advances; the pick just enables Submit.
    await user.click(screen.getByRole("radio", { name: "EU" }));
    expect(submit).toBeEnabled();
    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(submit);

    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond).toHaveBeenCalledWith({
      id: "q-visibility",
      action: "accept",
      content: { choice: "My team" },
    });
    expect(onRespond).toHaveBeenCalledWith({
      id: "q-region",
      action: "accept",
      content: { choice: "EU" },
    });
  });

  it("takes a typed Other answer inline without auto-advancing, and sends it on Submit", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    const owner = {
      ...singleChoice({
        id: "q-owner",
        header: "Owner",
        message: "Which GitHub account owns the repository?",
        options: ["my-user", "my-org"],
      }),
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "Choice",
            enum: ["my-user", "my-org"],
          },
          [ASK_USER_OTHER_ANSWER_FIELD]: {
            type: "string",
            title: "Type something",
          },
        },
        required: [],
      },
    };
    expect(isChoiceElicitationRequest(owner)).toBe(true);

    render(
      <McpElicitationCard
        requests={[
          owner,
          singleChoice({
            id: "q-name",
            message: "Repository name?",
            options: ["openappa-policy", "guardrails"],
          }),
        ]}
        onRespond={onRespond}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Type something" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Type something" }));
    expect(
      screen.getByRole("textbox", { name: "Type something" }),
    ).toHaveFocus();
    await user.keyboard("acme");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveTextContent(
      "(answered)",
    );

    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await user.click(screen.getByRole("radio", { name: "guardrails" }));
    await user.click(screen.getByTestId("mcp-elicitation-submit"));

    expect(onRespond).toHaveBeenCalledWith({
      id: "q-owner",
      action: "accept",
      content: { choice: "", [ASK_USER_OTHER_ANSWER_FIELD]: "acme" },
    });
    expect(onRespond).toHaveBeenCalledWith({
      id: "q-name",
      action: "accept",
      content: { choice: "guardrails" },
    });
  });

  it("stays on the question when the user types right after clicking an option", async () => {
    const user = userEvent.setup();
    render(
      <McpElicitationCard
        requests={[
          withOther(
            singleChoice({
              id: "q-owner",
              header: "Owner",
              message: "Owner?",
              options: ["my-user", "my-org"],
            }),
          ),
          singleChoice({
            id: "q-name",
            message: "Repository name?",
            options: ["openappa-policy", "guardrails"],
          }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "my-org" }));
    await user.click(screen.getByRole("radio", { name: "Type something" }));
    await user.type(
      screen.getByRole("textbox", { name: "Type something" }),
      "a",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("sends checked options with typed Other text, and drops the text once Other is unchecked", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    render(
      <McpElicitationCard
        requests={[
          withOther(
            multiChoice({
              id: "q-steps",
              message: "Which steps should run?",
              options: ["Run tests", "Deploy"],
            }),
          ),
        ]}
        onRespond={onRespond}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Run tests" }));
    await user.click(screen.getByRole("checkbox", { name: "Type something" }));
    await user.type(
      screen.getByRole("textbox", { name: "Type something" }),
      "lint",
    );
    await user.click(screen.getByRole("checkbox", { name: "Type something" }));
    expect(
      screen.queryByRole("textbox", { name: "Type something" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Type something" }));
    await user.type(
      screen.getByRole("textbox", { name: "Type something" }),
      "build",
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onRespond).toHaveBeenCalledExactlyOnceWith({
      id: "q-steps",
      action: "accept",
      content: {
        option_0: true,
        option_1: false,
        [ASK_USER_OTHER_ANSWER_FIELD]: "build",
      },
    });
  });

  it("keeps an enum and an independent optional text field off the inline card", () => {
    const request: ChatMcpElicitationRequest = {
      ...singleChoice({
        id: "q-deploy",
        message: "Deploy where?",
        options: ["staging", "production"],
      }),
      toolName: "deployer__deploy",
      requestedSchema: {
        type: "object",
        properties: {
          environment: { type: "string", enum: ["staging", "production"] },
          comment: { type: "string", title: "Comment" },
        },
        required: ["environment"],
      },
    };

    expect(isChoiceElicitationRequest(request)).toBe(false);
  });

  it("leaves a lone question's typed answer to the chat composer", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    render(
      <McpElicitationCard
        requests={[
          {
            ...singleChoice({
              id: "q-owner",
              message: "Owner?",
              options: ["my-user", "my-org"],
            }),
            requestedSchema: {
              type: "object",
              properties: {
                choice: { type: "string", enum: ["my-user", "my-org"] },
                [ASK_USER_OTHER_ANSWER_FIELD]: {
                  type: "string",
                  title: "Type something",
                },
              },
              required: [],
            },
          },
        ]}
        onRespond={onRespond}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Type something/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "my-org" }));

    expect(onRespond).toHaveBeenCalledExactlyOnceWith({
      id: "q-owner",
      action: "accept",
      content: { choice: "my-org", [ASK_USER_OTHER_ANSWER_FIELD]: "" },
    });
  });

  it("shows only navigation in the footer of every tab but the last", async () => {
    const user = userEvent.setup();

    render(
      <McpElicitationCard
        requests={[
          singleChoice({ id: "q-1", message: "First?", options: ["A", "B"] }),
          singleChoice({ id: "q-2", message: "Second?", options: ["C", "D"] }),
          singleChoice({ id: "q-3", message: "Third?", options: ["E", "F"] }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );
    const footerButtons = () =>
      within(screen.getByTestId("mcp-elicitation-footer"))
        .getAllByRole("button")
        .map((button) => button.textContent);

    expect(footerButtons()).toEqual(["Next"]);
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    expect(footerButtons()).toEqual(["Back", "Next"]);
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    expect(footerButtons()).toEqual(["Back", "Submit"]);
  });

  it("stays on the tab when an option is picked, until Next is clicked", async () => {
    const user = userEvent.setup();

    render(
      <McpElicitationCard
        requests={[
          singleChoice({ id: "q-1", message: "First?", options: ["A", "B"] }),
          singleChoice({ id: "q-2", message: "Second?", options: ["C", "D"] }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "A" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByText("First?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "A" })).toBeChecked();

    await user.click(screen.getByTestId("mcp-elicitation-next"));
    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("names each question's options after the question itself", async () => {
    const user = userEvent.setup();

    render(
      <McpElicitationCard
        requests={[
          singleChoice({
            id: "q-1",
            header: "Region",
            message: "Where should it run?",
            options: ["EU", "US"],
          }),
          multiChoice({
            id: "q-2",
            message: "Which steps should run?",
            options: ["Run tests", "Deploy"],
          }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    // Not the schema's generic "Choice" title, which every question shares.
    expect(
      screen.getByRole("radiogroup", { name: "Where should it run?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    expect(
      within(
        screen.getByRole("group", { name: "Which steps should run?" }),
      ).getAllByRole("checkbox"),
    ).toHaveLength(2);
  });

  it("shows the neighbouring tab, with focus kept in the card, when the shown question leaves", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    const first = singleChoice({
      id: "q-1",
      message: "First?",
      options: ["A", "B"],
    });
    const second = singleChoice({
      id: "q-2",
      message: "Second?",
      options: ["C", "D"],
    });
    const third = singleChoice({
      id: "q-3",
      message: "Third?",
      options: ["E", "F"],
    });

    const { rerender } = render(
      <McpElicitationCard
        requests={[first, second, third]}
        onRespond={onRespond}
      />,
    );
    await user.click(screen.getByTestId("mcp-elicitation-tab-2"));
    await user.click(screen.getByRole("radio", { name: "E" }));
    expect(screen.getByRole("radio", { name: "E" })).toHaveFocus();

    // The third question times out (or is answered from another client).
    rerender(
      <McpElicitationCard requests={[first, second]} onRespond={onRespond} />,
    );

    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Second?")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
  });

  it("keeps Submit disabled while an earlier tab is unanswered", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);

    render(
      <McpElicitationCard
        requests={[
          singleChoice({ id: "q-1", message: "First?", options: ["A", "B"] }),
          singleChoice({ id: "q-2", message: "Second?", options: ["C", "D"] }),
        ]}
        onRespond={onRespond}
      />,
    );

    // Skip the first question with Next.
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await user.click(screen.getByRole("radio", { name: "C" }));
    expect(screen.getByTestId("mcp-elicitation-submit")).toBeDisabled();

    await user.click(screen.getByTestId("mcp-elicitation-back"));
    expect(screen.getByText("First?")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "A" }));
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-elicitation-submit")).toBeEnabled(),
    );
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("does not auto-advance from a multi-choice tab; Next moves on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <McpElicitationCard
        requests={[
          multiChoice({
            id: "q-1",
            message: "Which steps should run?",
            options: ["Run tests", "Deploy"],
          }),
          singleChoice({ id: "q-2", message: "Where?", options: ["EU", "US"] }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Run tests" }));
    // Longer than the auto-advance delay.
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(screen.getByTestId("mcp-elicitation-next"));
    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches questions by clicking a tab", async () => {
    const user = userEvent.setup();

    render(
      <McpElicitationCard
        requests={[
          singleChoice({ id: "q-1", message: "First?", options: ["A", "B"] }),
          singleChoice({ id: "q-2", message: "Second?", options: ["C", "D"] }),
          singleChoice({ id: "q-3", message: "Third?", options: ["E", "F"] }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    await user.click(screen.getByTestId("mcp-elicitation-tab-2"));
    expect(screen.getByText("Third?")).toBeInTheDocument();
    expect(screen.getByTestId("mcp-elicitation-submit")).toBeInTheDocument();
  });

  it("confirms a keyboard pick with Enter instead of advancing on arrow keys", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <McpElicitationCard
        requests={[
          singleChoice({ id: "q-1", message: "First?", options: ["A", "B"] }),
          singleChoice({ id: "q-2", message: "Second?", options: ["C", "D"] }),
        ]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    const panel = screen.getByRole("tabpanel");
    within(panel).getByRole("radio", { name: "A" }).focus();
    await user.keyboard("[Space]");
    // Radix selects on its deferred focus move while the arrow is still held.
    await user.keyboard("{ArrowDown>}");
    await act(() => vi.advanceTimersByTimeAsync(20));
    await user.keyboard("{/ArrowDown}");
    expect(within(panel).getByRole("radio", { name: "B" })).toBeChecked();
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByText("First?")).toBeInTheDocument();

    await user.keyboard("[Enter]");
    expect(screen.getByText("Second?")).toBeInTheDocument();
  });

  it("appends a question that arrives later without losing picks or the active tab", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    const first = singleChoice({
      id: "q-1",
      message: "First?",
      options: ["A", "B"],
    });
    const second = singleChoice({
      id: "q-2",
      message: "Second?",
      options: ["C", "D"],
    });

    const { rerender } = render(
      <McpElicitationCard requests={[first, second]} onRespond={onRespond} />,
    );

    await user.click(screen.getByRole("radio", { name: "B" }));
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() =>
      expect(screen.getByText("Second?")).toBeInTheDocument(),
    );

    rerender(
      <McpElicitationCard
        requests={[
          first,
          second,
          singleChoice({ id: "q-3", message: "Third?", options: ["E", "F"] }),
        ]}
        onRespond={onRespond}
      />,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The second tab is no longer the last one.
    expect(screen.getByTestId("mcp-elicitation-next")).toBeInTheDocument();

    await user.click(screen.getByTestId("mcp-elicitation-tab-0"));
    expect(screen.getByRole("radio", { name: "B" })).toBeChecked();
  });

  it("keeps a question whose answer failed, with its pick, after the others leave", async () => {
    const user = userEvent.setup();
    const first = singleChoice({
      id: "q-1",
      message: "First?",
      options: ["A", "B"],
    });
    const second = singleChoice({
      id: "q-2",
      message: "Second?",
      options: ["C", "D"],
    });
    // The parent drops each question once its answer lands; q-2's fails.
    const onRespond = vi.fn().mockResolvedValue(true);

    const { rerender } = render(
      <McpElicitationCard requests={[first, second]} onRespond={onRespond} />,
    );

    await user.click(screen.getByRole("radio", { name: "A" }));
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() =>
      expect(screen.getByText("Second?")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("radio", { name: "D" }));
    await user.click(screen.getByTestId("mcp-elicitation-submit"));
    expect(onRespond).toHaveBeenCalledTimes(2);

    rerender(<McpElicitationCard requests={[second]} onRespond={onRespond} />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "D" }));
    expect(onRespond).toHaveBeenLastCalledWith({
      id: "q-2",
      action: "accept",
      content: { choice: "D" },
    });
  });

  it("keeps one group container through acknowledgement and the final summary", async () => {
    const first = singleChoice({
      id: "q-1",
      toolCallId: "call-1",
      message: "Pick a color",
      options: ["Blue", "Green"],
    });
    const second = singleChoice({
      id: "q-2",
      toolCallId: "call-2",
      message: "Pick a fruit",
      options: ["Apple", "Pear"],
    });
    const { rerender } = render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", { status: "waiting" }),
          groupMember("call-2", "Pick a fruit", { status: "waiting" }),
        ]}
        requests={[first, second]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
          groupMember("call-2", "Pick a fruit", { status: "waiting" }),
        ]}
        requests={[]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByText("Waiting for answers...")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Apple" })).toBeDisabled();

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
          groupMember("call-2", "Pick a fruit", {
            status: "answered",
            selected: ["Apple"],
          }),
        ]}
        requests={[]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByTestId("ask-user-tool-group")).toHaveAttribute(
      "data-state",
      "settled",
    );
    expect(screen.getByRole("list", { name: "Answers" })).toHaveTextContent(
      "Pick a colorBluePick a fruitApple",
    );
    expect(screen.queryByRole("button", { name: "Blue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apple" })).toBeNull();
  });

  it("orders tabs by members even when requests arrive in reverse order", async () => {
    const user = userEvent.setup();
    const first = singleChoice({
      id: "q-1",
      toolCallId: "call-1",
      header: "Visibility",
      message: "Who should see this?",
      options: ["Only me", "Team"],
    });
    const second = singleChoice({
      id: "q-2",
      toolCallId: "call-2",
      header: "Deploy",
      message: "Where should we deploy?",
      options: ["Staging", "Production"],
    });

    render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Who should see this?", { status: "waiting" }),
          groupMember("call-2", "Where should we deploy?", {
            status: "waiting",
          }),
        ]}
        requests={[second, first]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByTestId("mcp-elicitation-tab-0")).toHaveTextContent(
      "Visibility",
    );
    expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveTextContent(
      "Deploy",
    );
    expect(screen.getByRole("radio", { name: "Only me" })).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Staging" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Only me" }));
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() => {
      expect(
        screen.getByRole("radio", { name: "Staging" }),
      ).toBeInTheDocument();
    });
  });

  it("holds submitted tabs until every streamed result arrives", async () => {
    const user = userEvent.setup();
    const first = singleChoice({
      id: "q-1",
      toolCallId: "call-1",
      message: "Pick a color",
      options: ["Blue", "Green"],
    });
    const second = singleChoice({
      id: "q-2",
      toolCallId: "call-2",
      message: "Pick a fruit",
      options: ["Apple", "Pear"],
    });
    const firstResponse = deferred<boolean>();
    const secondResponse = deferred<boolean>();
    const onRespond = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const { rerender } = render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", { status: "waiting" }),
          groupMember("call-2", "Pick a fruit", { status: "waiting" }),
        ]}
        requests={[first, second]}
        onRespond={onRespond}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Blue" }));
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() =>
      expect(screen.getByText("Pick a fruit")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("radio", { name: "Apple" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText("Saving answers...")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
          groupMember("call-2", "Pick a fruit", { status: "waiting" }),
        ]}
        requests={[]}
        onRespond={onRespond}
      />,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      screen.queryByRole("list", { name: "Saved answers" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      firstResponse.resolve(true);
      secondResponse.resolve(true);
      await Promise.all([firstResponse.promise, secondResponse.promise]);
    });

    expect(
      screen.getByText("Waiting for answer results..."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      screen.queryByRole("list", { name: "Saved answers" }),
    ).not.toBeInTheDocument();

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
          groupMember("call-2", "Pick a fruit", {
            status: "answered",
            selected: ["Apple"],
          }),
        ]}
        requests={[]}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByRole("list", { name: "Answers" })).toHaveTextContent(
      "Pick a colorBluePick a fruitApple",
    );
  });

  it("settles a stopped group as no answer only after it had pending requests", () => {
    const request = singleChoice({
      id: "q-1",
      toolCallId: "call-1",
      message: "Pick a color",
      options: ["Blue", "Green"],
    });
    const { rerender } = render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[groupMember("call-1", "Pick a color", { status: "waiting" })]}
        requests={[request]}
        terminalIncomplete
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByRole("button", { name: "Blue" })).toBeEnabled();

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[groupMember("call-1", "Pick a color", { status: "waiting" })]}
        requests={[]}
        terminalIncomplete
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Answers" })).toHaveTextContent(
      "Pick a colorStopped without an answer",
    );

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[groupMember("call-1", "Pick a color", { status: "waiting" })]}
        requests={[]}
        terminalIncomplete={false}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Answers" })).toHaveTextContent(
      "Stopped without an answer",
    );
  });

  it("marks a typed answer apart from a picked option", () => {
    render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
          groupMember("call-2", "Which site?", {
            status: "answered",
            selected: [],
            text: "Google",
          }),
        ]}
        requests={[]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    const [picked, typed] = within(
      screen.getByRole("list", { name: "Answers" }),
    ).getAllByRole("listitem");
    expect(picked).toHaveTextContent("Pick a colorBlue");
    expect(picked).not.toHaveTextContent("Typed answer");
    expect(typed).toHaveTextContent("Which site?GoogleTyped answer");
  });

  it("folds a long answered question until the user expands it", async () => {
    const user = userEvent.setup();
    const longQuestion = `${"It is late on a Friday and prod is down. ".repeat(8)}What do you do first?`;
    render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", longQuestion, {
            status: "answered",
            selected: ["Roll back"],
          }),
          groupMember("call-2", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
        ]}
        requests={[]}
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    // Only the long question offers to expand.
    const toggle = screen.getByRole("button", { name: "Show full question" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);

    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("does not fabricate a stopped result for an initial replay gap", () => {
    render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[groupMember("call-1", "Pick a color", { status: "waiting" })]}
        requests={[]}
        terminalIncomplete
        onRespond={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.queryByTestId("ask-user-tool-group")).not.toBeInTheDocument();
  });

  it("retries only the failed member after another response is saved", async () => {
    const user = userEvent.setup();
    const first = singleChoice({
      id: "q-1",
      toolCallId: "call-1",
      message: "Pick a color",
      options: ["Blue", "Green"],
    });
    const second = singleChoice({
      id: "q-2",
      toolCallId: "call-2",
      message: "Pick a fruit",
      options: ["Apple", "Pear"],
    });
    const onRespond = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { rerender } = render(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", { status: "waiting" }),
          groupMember("call-2", "Pick a fruit", { status: "waiting" }),
        ]}
        requests={[first, second]}
        onRespond={onRespond}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Blue" }));
    await user.click(screen.getByTestId("mcp-elicitation-next"));
    await waitFor(() =>
      expect(screen.getByText("Pick a fruit")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("radio", { name: "Apple" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledTimes(2);

    rerender(
      <McpElicitationCard
        groupId="assistant-1-ask-user-1"
        members={[
          groupMember("call-1", "Pick a color", {
            status: "answered",
            selected: ["Blue"],
          }),
          groupMember("call-2", "Pick a fruit", { status: "waiting" }),
        ]}
        requests={[second]}
        onRespond={onRespond}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Apple" }));
    expect(onRespond).toHaveBeenLastCalledWith({
      id: "q-2",
      action: "accept",
      content: { choice: "Apple" },
    });
  });
});

function withOther(
  request: ChatMcpElicitationRequest,
): ChatMcpElicitationRequest {
  const schema = request.requestedSchema as {
    properties: Record<string, unknown>;
  };
  return {
    ...request,
    requestedSchema: {
      type: "object",
      properties: {
        ...schema.properties,
        [ASK_USER_OTHER_ANSWER_FIELD]: {
          type: "string",
          title: "Type something",
        },
      },
      required: [],
    },
  };
}

function singleChoice(params: {
  id: string;
  message: string;
  options: string[];
  header?: string;
  toolCallId?: string;
}): ChatMcpElicitationRequest {
  return {
    id: params.id,
    conversationId: CONVERSATION_ID,
    toolName: "archestra__ask_user",
    message: params.message,
    mode: "form",
    header: params.header,
    toolCallId: params.toolCallId,
    requestedSchema: {
      type: "object",
      properties: {
        choice: { type: "string", title: "Choice", enum: params.options },
      },
      required: ["choice"],
    },
  };
}

function openappaReview(): ChatMcpElicitationRequest {
  return {
    id: "review-1",
    conversationId: CONVERSATION_ID,
    toolName: "archestra__execute_remedy_plan",
    message: [
      'APPA asks you to rule as the authority "operator".',
      "",
      "Tool: archestra__todo_write",
      "Arguments:",
      '{"todos":"[{\\"id\\":1,\\"content\\":\\"qa-hitl\\",\\"status\\":\\"pending\\"}]"}',
      "",
      "What this ruling would cover:",
      "  attention: signoff",
    ].join("\n"),
    mode: "form",
    kind: "openappa_review",
    reviewedTool: "archestra__todo_write",
    reviewedArguments:
      '{"todos":"[{\\"id\\":1,\\"content\\":\\"qa-hitl\\",\\"status\\":\\"pending\\"}]"}',
    requestedSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          title: "Action",
          enum: ["approve", "deny"],
        },
      },
      required: ["action"],
    },
  };
}

function groupMember(
  toolCallId: string,
  question: string,
  outcome: AskUserGroupMember["outcome"],
) {
  return { toolCallId, question, outcome };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function multiChoice(params: {
  id: string;
  message: string;
  options: string[];
}): ChatMcpElicitationRequest {
  return {
    id: params.id,
    conversationId: CONVERSATION_ID,
    toolName: "archestra__ask_user",
    message: params.message,
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: Object.fromEntries(
        params.options.map((label, index) => [
          `option_${index}`,
          { type: "boolean", title: label, default: false },
        ]),
      ),
    },
  };
}
