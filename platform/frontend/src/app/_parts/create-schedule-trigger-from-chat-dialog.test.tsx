import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateScheduleTriggerFromChatDialog } from "./create-schedule-trigger-from-chat-dialog";

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/agent.query", () => ({
  useProfiles: () => ({
    data: [{ id: "agent-1", name: "Agent 1", scope: "org" }],
  }),
}));

const mockMutateAsync = vi.fn().mockResolvedValue({ id: "schedule-1" });
vi.mock("@/lib/schedule-trigger.query", () => ({
  useCreateScheduleTrigger: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/components/agent-selector", () => ({
  AgentSelector: ({ value, onValueChange }: any) => (
    <select
      data-testid="agent-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="agent-1">Agent 1</option>
    </select>
  ),
}));

vi.mock("@/components/ui/cron-expression-picker", () => ({
  CronExpressionPicker: ({ value, onChange }: any) => (
    <input
      data-testid="cron-picker"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  DEFAULT_CRON_PRESET_OPTIONS: [],
}));

vi.mock("@/components/ui/timezone-picker", () => ({
  TimezonePicker: ({ value, onValueChange }: any) => (
    <input
      data-testid="timezone-picker"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
}));

describe("CreateScheduleTriggerFromChatDialog", () => {
  const conversation = {
    id: "conv-1",
    title: "Test Conversation",
    agentId: "agent-1",
    projectId: "project-1",
    messages: [
      { id: "m1", role: "user", content: "Hello Agent!" },
      { id: "m2", role: "assistant", content: "Hi there!" },
    ],
  } as any;

  it("pre-fills form state from the conversation and submits", async () => {
    const onOpenChange = vi.fn();
    render(
      <CreateScheduleTriggerFromChatDialog
        conversationId="conv-1"
        conversation={conversation}
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    expect(screen.getByLabelText(/Name/i)).toHaveValue(
      "Schedule for Test Conversation",
    );
    expect(screen.getByLabelText(/Task prompt/i)).toHaveValue("Hello Agent!");

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: "Custom Schedule Name" } });

    const form = screen
      .getByRole("button", { name: /Create/i })
      .closest("form");
    expect(form).toBeDefined();

    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        name: "Custom Schedule Name",
        messageTemplate: "Hello Agent!",
        cronExpression: "0 9 * * 1-5",
        timezone: expect.any(String),
        agentId: "agent-1",
        projectId: "project-1",
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
