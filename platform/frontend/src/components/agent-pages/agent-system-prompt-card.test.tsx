import {
  BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS,
  BUILT_IN_AGENT_IDS,
} from "@archestra/shared";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateProfile } from "@/lib/agent.query";
import { AgentSystemPromptCard } from "./agent-system-prompt-card";

vi.mock("@/lib/agent.query", () => ({ useUpdateProfile: vi.fn() }));
vi.mock("next/navigation");
vi.mock("@/components/system-prompt-editor", () => ({
  SystemPromptEditor: ({
    title,
    value,
    onChange,
    readOnly,
    headerExtra,
  }: {
    title: string;
    value: string;
    onChange: (value: string) => void;
    readOnly: boolean;
    headerExtra?: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      {headerExtra}
      <textarea
        aria-label={title}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  ),
}));

const mutate = vi.fn();
const push = vi.fn();

describe("AgentSystemPromptCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push } as never);
    vi.mocked(useUpdateProfile).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateProfile>);
  });

  it("saves an edited system prompt directly from the overview", async () => {
    const user = userEvent.setup();
    render(
      <AgentSystemPromptCard
        agent={{ id: "agent-1", systemPrompt: "Old prompt" }}
        readOnly={false}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "System prompt" });
    fireEvent.change(editor, { target: { value: "  New prompt  " } });
    await user.click(
      screen.getByRole("button", { name: "Save system prompt" }),
    );

    expect(mutate).toHaveBeenCalledWith({
      id: "agent-1",
      data: { systemPrompt: "New prompt" },
    });
  });

  it("shows the prompt without edit controls to a read-only viewer", () => {
    render(
      <AgentSystemPromptCard
        agent={{ id: "agent-1", systemPrompt: "Read me" }}
        readOnly
      />,
    );

    expect(screen.getByRole("textbox", { name: "System prompt" })).toHaveValue(
      "Read me",
    );
    expect(screen.getByRole("form", { name: "System prompt" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save system prompt" }),
    ).toBeNull();
  });

  it("resets local prompt state when the agent changes", () => {
    const { rerender } = render(
      <AgentSystemPromptCard
        key="agent-1"
        agent={{ id: "agent-1", systemPrompt: "First prompt" }}
        readOnly={false}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "System prompt" }), {
      target: { value: "Unsaved first prompt" },
    });

    rerender(
      <AgentSystemPromptCard
        key="agent-2"
        agent={{ id: "agent-2", systemPrompt: "Second prompt" }}
        readOnly={false}
      />,
    );

    expect(screen.getByRole("textbox", { name: "System prompt" })).toHaveValue(
      "Second prompt",
    );
  });

  it("syncs a clean editor when the same agent receives a newer prompt", async () => {
    const { rerender } = render(
      <AgentSystemPromptCard
        agent={{ id: "agent-1", systemPrompt: "First prompt" }}
        readOnly={false}
      />,
    );

    rerender(
      <AgentSystemPromptCard
        agent={{ id: "agent-1", systemPrompt: "Updated elsewhere" }}
        readOnly={false}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "System prompt" }),
      ).toHaveValue("Updated elsewhere"),
    );
  });

  it("guards in-app navigation while the prompt has unsaved changes", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AgentSystemPromptCard
          agent={{ id: "agent-1", systemPrompt: "Old prompt" }}
          readOnly={false}
        />
        <a href="/agents/agent-2">Another agent</a>
      </>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "System prompt" }), {
      target: { value: "Unsaved prompt" },
    });

    await user.click(screen.getByRole("link", { name: "Another agent" }));
    expect(push).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    expect(push).toHaveBeenCalledWith("/agents/agent-2");
  });

  it("does not guard a same-page skip link", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AgentSystemPromptCard
          agent={{ id: "agent-1", systemPrompt: "Old prompt" }}
          readOnly={false}
        />
        <a href="#main-content">Skip to content</a>
      </>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "System prompt" }), {
      target: { value: "Unsaved prompt" },
    });

    await user.click(screen.getByRole("link", { name: "Skip to content" }));

    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("restores a built-in agent's default prompt", async () => {
    const user = userEvent.setup();
    render(
      <AgentSystemPromptCard
        agent={{ id: "agent-1", systemPrompt: "Customized" }}
        readOnly={false}
        builtInAgentName={BUILT_IN_AGENT_IDS.POLICY_CONFIG}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset to Default" }));
    expect(screen.getByRole("textbox", { name: "System prompt" })).toHaveValue(
      BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS[BUILT_IN_AGENT_IDS.POLICY_CONFIG],
    );
  });
});
