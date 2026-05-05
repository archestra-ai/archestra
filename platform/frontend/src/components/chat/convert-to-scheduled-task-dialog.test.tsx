import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvertToScheduledTaskDialog } from "./convert-to-scheduled-task-dialog";

type FormProps = {
  agentOptions: Array<{ value: string; label: string }>;
  agentSelectDisabled?: boolean;
  agentSelectHelpText?: string;
  hasAgents: boolean;
  values: { agentId: string };
  onAgentChange: (value: string) => void;
};

let capturedProps: FormProps | null = null;
const changeAgent = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/scheduled-tasks/schedule-trigger-form-dialog", () => ({
  ScheduleTriggerFormDialog: (props: FormProps & Record<string, unknown>) => {
    capturedProps = props;
    return (
      <div data-testid="form-dialog">
        <p data-testid="help-text">{props.agentSelectHelpText ?? ""}</p>
        <p data-testid="selector-disabled">
          {String(!!props.agentSelectDisabled)}
        </p>
        <ul data-testid="agent-options">
          {props.agentOptions.map((o) => (
            <li key={o.value} data-value={o.value}>
              {o.label}
            </li>
          ))}
        </ul>
        <p data-testid="selected-agent">{props.values.agentId}</p>
      </div>
    );
  },
}));

const mockUseConversationScheduleTriggerSuggestion = vi.fn();
vi.mock("@/lib/schedule-trigger.query", () => ({
  useConversationScheduleTriggerSuggestion: () =>
    mockUseConversationScheduleTriggerSuggestion(),
  useCreateScheduleTriggerFromConversation: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
  }),
}));

const mockUseProfiles = vi.fn();
vi.mock("@/lib/agent.query", () => ({
  useProfiles: (...args: unknown[]) => mockUseProfiles(...args),
}));

const CURRENT_AGENT = {
  id: "agent-current",
  name: "Current Agent",
  icon: null,
};
const HISTORICAL_AGENT = {
  id: "agent-historical",
  name: "Historical Agent",
  icon: null,
};
const OTHER_AGENT = {
  id: "agent-other",
  name: "Other Agent",
  icon: null,
};

const ALL_AGENTS = [
  { id: CURRENT_AGENT.id, name: CURRENT_AGENT.name, description: null },
  { id: HISTORICAL_AGENT.id, name: HISTORICAL_AGENT.name, description: null },
  { id: OTHER_AGENT.id, name: OTHER_AGENT.name, description: null },
];

function renderDialog() {
  return render(
    <ConvertToScheduledTaskDialog
      conversationId="conv-1"
      open
      onOpenChange={vi.fn()}
    />,
  );
}

type CapturedFormProps = FormProps & {
  postEnabledSection: React.ReactElement<{
    children: [
      unknown,
      React.ReactElement<{ onCheckedChange: (checked: boolean) => void }>,
    ];
  }>;
};

function getReplyToggleHandler(): (checked: boolean) => void {
  const props = capturedProps as unknown as CapturedFormProps;
  return props.postEnabledSection.props.children[1].props.onCheckedChange;
}

describe("ConvertToScheduledTaskDialog — reply-in-same-conversation", () => {
  beforeEach(() => {
    capturedProps = null;
    changeAgent.mockReset();
    mockUseProfiles.mockReturnValue({ data: ALL_AGENTS, isLoading: false });
  });

  it("renders ONLY historical + current agents as options when replyInSameConversation is on", async () => {
    mockUseConversationScheduleTriggerSuggestion.mockReturnValue({
      data: {
        suggestedAgentId: CURRENT_AGENT.id,
        candidates: [
          {
            agent: CURRENT_AGENT,
            interactionCount: 2,
            lastUsedAt: new Date().toISOString(),
          },
          {
            agent: HISTORICAL_AGENT,
            interactionCount: 5,
            lastUsedAt: new Date().toISOString(),
          },
        ],
        reason: "current-conversation-agent",
        suggestedName: "Daily digest",
        suggestedMessageTemplate: "",
        suggestedMessageTemplatePreview: "",
      },
      isPending: false,
    });

    renderDialog();

    // Initially shows full agent list (replyInSameConversation=false by default).
    expect(screen.getByTestId("help-text").textContent).toBe("");
    expect(
      Array.from(
        screen.getByTestId("agent-options").querySelectorAll("li"),
      ).map((li) => li.getAttribute("data-value")),
    ).toEqual([CURRENT_AGENT.id, HISTORICAL_AGENT.id, OTHER_AGENT.id]);

    const toggleReplyInSameConversation = getReplyToggleHandler();
    await act(async () => {
      toggleReplyInSameConversation(true);
    });

    const optionValues = Array.from(
      screen.getByTestId("agent-options").querySelectorAll("li"),
    ).map((li) => li.getAttribute("data-value"));
    expect(optionValues).toEqual([CURRENT_AGENT.id, HISTORICAL_AGENT.id]);
    expect(optionValues).not.toContain(OTHER_AGENT.id);
    expect(screen.getByTestId("help-text").textContent).toBe(
      "Pick any agent that has already participated in this chat.",
    );
    expect(screen.getByTestId("selector-disabled").textContent).toBe("false");
  });

  it("does NOT override a manual agent pick while replyInSameConversation stays on", async () => {
    mockUseConversationScheduleTriggerSuggestion.mockReturnValue({
      data: {
        suggestedAgentId: CURRENT_AGENT.id,
        candidates: [
          {
            agent: CURRENT_AGENT,
            interactionCount: 2,
            lastUsedAt: new Date().toISOString(),
          },
          {
            agent: HISTORICAL_AGENT,
            interactionCount: 5,
            lastUsedAt: new Date().toISOString(),
          },
        ],
        reason: "current-conversation-agent",
        suggestedName: "Daily digest",
        suggestedMessageTemplate: "",
        suggestedMessageTemplatePreview: "",
      },
      isPending: false,
    });

    renderDialog();

    const toggleReplyInSameConversation = getReplyToggleHandler();
    await act(async () => {
      toggleReplyInSameConversation(true);
    });

    expect(screen.getByTestId("selected-agent").textContent).toBe(
      CURRENT_AGENT.id,
    );

    const { onAgentChange } = capturedProps as unknown as CapturedFormProps;

    await act(async () => {
      onAgentChange(HISTORICAL_AGENT.id);
    });

    expect(screen.getByTestId("selected-agent").textContent).toBe(
      HISTORICAL_AGENT.id,
    );
  });

  it("disables selector with a no-history help text when candidates are empty", async () => {
    mockUseConversationScheduleTriggerSuggestion.mockReturnValue({
      data: {
        suggestedAgentId: null,
        candidates: [],
        reason: "none",
        suggestedName: "Daily digest",
        suggestedMessageTemplate: "",
        suggestedMessageTemplatePreview: "",
      },
      isPending: false,
    });

    renderDialog();

    const toggleReplyInSameConversation = getReplyToggleHandler();
    await act(async () => {
      toggleReplyInSameConversation(true);
    });

    expect(screen.getByTestId("selector-disabled").textContent).toBe("true");
    expect(screen.getByTestId("help-text").textContent).toContain(
      "no agent history",
    );
    expect(
      Array.from(screen.getByTestId("agent-options").querySelectorAll("li"))
        .length,
    ).toBe(0);
  });
});
