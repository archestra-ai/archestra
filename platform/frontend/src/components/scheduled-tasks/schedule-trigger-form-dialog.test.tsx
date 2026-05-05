import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScheduleTriggerFormDialog } from "./schedule-trigger-form-dialog";

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useMissingPermissions: () => [],
}));

describe("ScheduleTriggerFormDialog", () => {
  it("disables submit when form is invalid", () => {
    render(
      <ScheduleTriggerFormDialog
        open
        onOpenChange={vi.fn()}
        title="New task"
        values={{
          name: "",
          agentId: "",
          cronExpression: "0 9 * * 1,2,3,4,5",
          timezone: "UTC",
          messageTemplate: "",
          replyChannel: "chat",
        }}
        agentOptions={[]}
        agentsLoading={false}
        hasAgents={false}
        isSaving={false}
        isFormValid={false}
        permissions={{ scheduledTask: ["create"] }}
        submitLabel="Create"
        onSubmit={vi.fn()}
        onNameChange={vi.fn()}
        onAgentChange={vi.fn()}
        onCronExpressionChange={vi.fn()}
        onMessageTemplateChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("submits via the internal form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <ScheduleTriggerFormDialog
        open
        onOpenChange={vi.fn()}
        title="New task"
        values={{
          name: "Test",
          agentId: "agent-1",
          cronExpression: "0 9 * * 1,2,3,4,5",
          timezone: "UTC",
          messageTemplate: "Do it",
          replyChannel: "chat",
        }}
        agentOptions={[{ value: "agent-1", label: "Agent" }]}
        agentsLoading={false}
        hasAgents
        isSaving={false}
        isFormValid
        permissions={{ scheduledTask: ["create"] }}
        submitLabel="Create"
        onSubmit={onSubmit}
        onNameChange={vi.fn()}
        onAgentChange={vi.fn()}
        onCronExpressionChange={vi.fn()}
        onMessageTemplateChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("renders custom prompt label", () => {
    render(
      <ScheduleTriggerFormDialog
        open
        onOpenChange={vi.fn()}
        title="New task"
        values={{
          name: "Test",
          agentId: "agent-1",
          cronExpression: "0 9 * * 1,2,3,4,5",
          timezone: "UTC",
          messageTemplate: "Hi",
          replyChannel: "chat",
        }}
        agentOptions={[{ value: "agent-1", label: "Agent" }]}
        agentsLoading={false}
        hasAgents
        isSaving={false}
        isFormValid
        permissions={{ scheduledTask: ["create"] }}
        submitLabel="Create"
        onSubmit={vi.fn()}
        onNameChange={vi.fn()}
        onAgentChange={vi.fn()}
        onCronExpressionChange={vi.fn()}
        onMessageTemplateChange={vi.fn()}
        promptLabel="Summary"
      />,
    );

    expect(screen.getByText("Summary")).toBeInTheDocument();
  });

  it("only renders reply channel dropdown when multiple channels are available", () => {
    const { rerender } = render(
      <ScheduleTriggerFormDialog
        open
        onOpenChange={vi.fn()}
        title="New task"
        values={{
          name: "Test",
          agentId: "agent-1",
          cronExpression: "0 9 * * 1,2,3,4,5",
          timezone: "UTC",
          messageTemplate: "Hi",
          replyChannel: "chat",
        }}
        agentOptions={[{ value: "agent-1", label: "Agent" }]}
        agentsLoading={false}
        hasAgents
        isSaving={false}
        isFormValid
        permissions={{ scheduledTask: ["create"] }}
        submitLabel="Create"
        onSubmit={vi.fn()}
        onNameChange={vi.fn()}
        onAgentChange={vi.fn()}
        onCronExpressionChange={vi.fn()}
        onMessageTemplateChange={vi.fn()}
        availableReplyChannels={["chat"]}
        onReplyChannelChange={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Reply in")).not.toBeInTheDocument();

    rerender(
      <ScheduleTriggerFormDialog
        open
        onOpenChange={vi.fn()}
        title="New task"
        values={{
          name: "Test",
          agentId: "agent-1",
          cronExpression: "0 9 * * 1,2,3,4,5",
          timezone: "UTC",
          messageTemplate: "Hi",
          replyChannel: "chat",
        }}
        agentOptions={[{ value: "agent-1", label: "Agent" }]}
        agentsLoading={false}
        hasAgents
        isSaving={false}
        isFormValid
        permissions={{ scheduledTask: ["create"] }}
        submitLabel="Create"
        onSubmit={vi.fn()}
        onNameChange={vi.fn()}
        onAgentChange={vi.fn()}
        onCronExpressionChange={vi.fn()}
        onMessageTemplateChange={vi.fn()}
        availableReplyChannels={["chat", "slack_dm"]}
        onReplyChannelChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Reply in")).toBeInTheDocument();
  });
});
