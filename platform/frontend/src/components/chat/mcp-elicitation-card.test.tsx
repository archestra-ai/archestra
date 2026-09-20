import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AskUserGroupMember } from "./ask-user-outcome";
import { McpElicitationCard } from "./mcp-elicitation-card";
import type { ChatMcpElicitationRequest } from "./mcp-elicitation-fields";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000100";

describe("McpElicitationCard", () => {
  it("shows a single question with Dismiss and Submit, no tabs or navigation", async () => {
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
      screen.getByRole("button", { name: "Dismiss question" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 1", { exact: false })).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByRole("radio", { name: "Accept for this session" }),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      id: "q-1",
      action: "accept",
      content: { choice: "Accept for this session" },
    });
  });

  it("dismisses a single question from the header without submitting a selection", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(true);
    render(
      <McpElicitationCard
        requests={[
          singleChoice({
            id: "q-1",
            message: "Who should see the app?",
            options: ["Only me", "Team"],
          }),
        ]}
        onRespond={onRespond}
      />,
    );

    const dismiss = screen.getByRole("button", { name: "Dismiss question" });
    dismiss.focus();
    await user.keyboard("{Enter}");
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({
      id: "q-1",
      action: "cancel",
    });
  });

  it("keeps Submit disabled on a multi-choice question until one option is checked", async () => {
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
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Deploy" }));
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onRespond).toHaveBeenCalledWith({
      id: "q-1",
      action: "accept",
      content: { option_0: false, option_1: true },
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

    // Picking a single-choice option answers the tab and moves on.
    await user.click(screen.getByRole("radio", { name: "My team" }));
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
    // Dismissing stays within reach on every tab, from the header.
    expect(
      screen.getByRole("button", { name: "Dismiss questions" }),
    ).toBeInTheDocument();
  });

  it("moves on when the already-picked option is clicked again", async () => {
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
    await waitFor(() =>
      expect(screen.getByText("Second?")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("mcp-elicitation-back"));
    expect(screen.getByRole("radio", { name: "A" })).toBeChecked();

    // Confirming the answer it already has moves on, like the first pick.
    await user.click(screen.getByRole("radio", { name: "A" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-elicitation-tab-1")).toHaveAttribute(
        "aria-selected",
        "true",
      ),
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
    await waitFor(() =>
      expect(screen.getByTestId("mcp-elicitation-submit")).toBeEnabled(),
    );
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("does not auto-advance from a multi-choice tab; Next moves on", async () => {
    const user = userEvent.setup();

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
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
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

    const panel = screen.getByRole("tabpanel");
    within(panel).getByRole("radio", { name: "A" }).focus();
    await user.keyboard("[Space]");
    // Radix selects on its deferred focus move while the arrow is still held.
    await user.keyboard("{ArrowDown>}");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await user.keyboard("{/ArrowDown}");
    expect(within(panel).getByRole("radio", { name: "B" })).toBeChecked();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(screen.getByText("First?")).toBeInTheDocument();

    await user.keyboard("[Enter]");
    expect(screen.getByText("Second?")).toBeInTheDocument();
  });

  it("dismisses every question in the card from its header", async () => {
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

    await user.click(screen.getByRole("button", { name: "Dismiss questions" }));

    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond).toHaveBeenCalledWith({ id: "q-1", action: "cancel" });
    expect(onRespond).toHaveBeenCalledWith({ id: "q-2", action: "cancel" });
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
    await waitFor(() =>
      expect(screen.getByText("Second?")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("radio", { name: "D" }));
    await user.click(screen.getByTestId("mcp-elicitation-submit"));
    expect(onRespond).toHaveBeenCalledTimes(2);

    rerender(<McpElicitationCard requests={[second]} onRespond={onRespond} />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "D" })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled(),
    );
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

    expect(screen.getByRole("radio", { name: "Blue" })).toBeEnabled();

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

    expect(screen.getByRole("radio", { name: "Apple" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenLastCalledWith({
      id: "q-2",
      action: "accept",
      content: { choice: "Apple" },
    });
  });
});

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
