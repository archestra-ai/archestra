import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyBindingPlan = vi.fn(
  (
    _body: unknown,
    options?: {
      onSuccess?: (bindings: Array<Record<string, unknown>>) => void;
      onError?: (error: Error) => void;
    },
  ) => options?.onSuccess?.([]),
);
const isChannelHidden = vi.fn().mockReturnValue(false);
const refetchAgentNames = vi.fn();
const refetchBindings = vi.fn();
const refetchProviders = vi.fn();
const updateBinding = vi.fn();
const hasUpdatePermission = vi.fn(() => true);
const hasAgentUpdatePermission = vi.fn(() => true);
const hasCreatePermission = vi.fn(() => true);

vi.mock("@/lib/agent.query", () => ({
  useProfiles: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
  useHasPermissions: (permissions: Record<string, string[]>) => ({
    data:
      "agent" in permissions
        ? hasAgentUpdatePermission()
        : permissions.agentTrigger?.includes("create")
          ? hasCreatePermission()
          : hasUpdatePermission(),
  }),
}));

vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
  useChatOpsStatus: vi.fn(),
  useApplyChatOpsBindingPlan: () => ({
    mutate: applyBindingPlan,
    isPending: false,
  }),
  useUpdateChatOpsBinding: () => ({
    mutate: updateBinding,
    isPending: false,
  }),
}));

vi.mock("@/lib/chatops/incoming-email.query", () => ({
  useAgentEmailAddress: () => ({
    data: { emailAddress: "operations@example.com" },
  }),
}));

vi.mock(
  "@/app/settings/messaging-channels/email/agent-email-settings-dialog",
  () => ({
    AgentEmailSettingsDialog: ({ open }: { open: boolean }) =>
      open ? <div role="dialog" aria-label="Email settings" /> : null,
  }),
);

vi.mock("@/components/system-prompt-editor", () => ({
  SystemPromptEditor: ({
    title,
    value,
    onChange,
    readOnly,
  }: {
    title: string;
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label={title}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/integration-overrides", () => ({
  useMessagingChannelCatalog: () => ({ isHidden: isChannelHidden }),
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="scroll-area-viewport">{children}</div>
  ),
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: ({
    open,
    title,
    description,
    onOpenChange,
    onConfirm,
    confirmLabel,
  }: {
    open: boolean;
    title: React.ReactNode;
    description: React.ReactNode;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    confirmLabel: string;
  }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        <div>{description}</div>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { useProfiles } from "@/lib/agent.query";
import {
  useAllChatOpsBindings,
  useChatOpsStatus,
} from "@/lib/chatops/chatops.query";
import { useConfig } from "@/lib/config/config.query";
import {
  AgentChatAppsEditor as AgentChatApps,
  AgentChatApps as AgentChatAppsDetail,
} from "./agent-chat-apps";

const bindings = [
  {
    id: "binding-1",
    provider: "slack",
    channelId: "C1",
    channelName: "General",
    workspaceName: "Workspace",
    workspaceId: "W1",
    agentId: "agent-1",
    isDm: false,
  },
  {
    id: "binding-2",
    provider: "ms-teams",
    channelId: "C2",
    channelName: "Operations",
    workspaceName: "Team",
    workspaceId: "W2",
    agentId: "agent-2",
    isDm: false,
  },
];

const agent = {
  id: "agent-1",
  name: "Operations Agent",
  scope: "org",
  authorId: "user-1",
} as never;

describe("AgentChatAppsEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasUpdatePermission.mockReturnValue(true);
    hasAgentUpdatePermission.mockReturnValue(true);
    hasCreatePermission.mockReturnValue(true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    isChannelHidden.mockReturnValue(false);
    vi.mocked(useConfig).mockReturnValue({
      data: {
        features: {
          chatopsTelegramEnabled: true,
          incomingEmail: { enabled: true },
        },
      },
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as never);
    vi.mocked(useProfiles).mockReturnValue({
      data: [{ id: "agent-2", name: "Incident Agent" }],
      isPending: false,
      isLoadingError: false,
      refetch: refetchAgentNames,
    } as never);
    vi.mocked(useChatOpsStatus).mockReturnValue({
      data: [
        { id: "slack", configured: true },
        { id: "ms-teams", configured: false },
        { id: "telegram", configured: false },
      ],
      isPending: false,
      isLoadingError: false,
      refetch: refetchProviders,
    } as never);
    refetchBindings.mockResolvedValue({
      data: { bindings },
      isError: false,
    });
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
  });

  it("shows chat app connection status and channels assigned to this agent", () => {
    render(<AgentChatApps agent={agent} />);

    expect(
      screen.getByRole("link", { name: /Slack\s*Connected/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /MS Teams\s*Set up/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Telegram\s*Set up/ }),
    ).toBeVisible();
    expect(screen.getByText("General")).toBeVisible();
    expect(screen.getByText("Operations")).toBeVisible();
    expect(screen.getByRole("link", { name: "Incident Agent" })).toBeVisible();
  });

  it("does not link an assigned agent the caller cannot read", () => {
    vi.mocked(useProfiles).mockReturnValue({
      data: [],
      isPending: false,
      isLoadingError: false,
      refetch: refetchAgentNames,
    } as never);

    render(<AgentChatApps agent={agent} />);

    expect(screen.getByText("another agent")).toBeVisible();
    expect(screen.queryByRole("link", { name: "another agent" })).toBeNull();
  });

  it("keeps the detail summary read-only", () => {
    render(<AgentChatAppsDetail agent={agent} />);

    expect(screen.getByText("General")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Slack\s*Connected/ }),
    ).toHaveAttribute("href", "/settings/messaging-channels/slack");
    expect(
      screen.getByRole("link", { name: /MS Teams\s*Set up/ }),
    ).toHaveAttribute("href", "/settings/messaging-channels/ms-teams");
    expect(
      screen.getByRole("link", { name: /Telegram\s*Set up/ }),
    ).toHaveAttribute("href", "/settings/messaging-channels/telegram");
    expect(
      screen.getByRole("link", { name: /Email\s*Connected/ }),
    ).toHaveAttribute("href", "/settings/messaging-channels/email");
    expect(
      screen.queryByRole("button", { name: "Manage channels" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /instructions/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /Answer all messages/i }),
    ).not.toBeInTheDocument();
  });

  it("includes an enabled email channel in detail and Edit collections", async () => {
    const user = userEvent.setup();
    const emailAgent = {
      id: "agent-1",
      name: "Operations Agent",
      scope: "org",
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
    } as never;
    const { unmount } = render(<AgentChatAppsDetail agent={emailAgent} />);

    expect(screen.getByText("operations@example.com")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Edit email for Email channel operations@example.com",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Email settings" }),
    ).toBeVisible();
    unmount();
    render(<AgentChatApps agent={emailAgent} />);

    const emailCheckbox = screen.getByRole("checkbox", {
      name: "Email channel",
    });
    expect(emailCheckbox).toBeChecked();
    expect(screen.getByText("operations@example.com")).toBeVisible();
    await user.click(emailCheckbox);
    expect(
      screen.getByRole("dialog", { name: "Email settings" }),
    ).toBeVisible();
  });

  it("shows assignment controls immediately without another editing mode", () => {
    render(<AgentChatApps agent={agent} />);

    expect(
      screen.getByRole("textbox", { name: "Search channels" }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel General",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Manage channels" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", {
        name: "Choose channels for Operations Agent",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toBeVisible();
  });

  it("opens details from the row without changing assignment", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);
    const checkbox = screen.getByRole("checkbox", {
      name: "MS Teams channel Operations",
    });
    const row = checkbox.closest("[data-channel-assignment-row]");
    expect(row).not.toBeNull();
    const rowTarget = within(row as HTMLElement).getByRole("button", {
      name: "View details for MS Teams channel Operations",
    });

    await user.click(rowTarget);

    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("dialog", { name: "Operations" })).toBeVisible();
  });

  it("keeps list order when a channel is checked", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);
    const labelsBefore = screen
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.getAttribute("aria-label"));

    await user.click(
      screen.getByRole("checkbox", { name: "Slack direct message" }),
    );

    expect(
      screen
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.getAttribute("aria-label")),
    ).toEqual(labelsBefore);
  });

  it("keeps list order and scroll position when a channel is unchecked", async () => {
    const user = userEvent.setup();
    const { container } = render(<AgentChatApps agent={agent} />);
    const viewport = container.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement;
    viewport.scrollTop = 80;
    const labelsBefore = screen
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.getAttribute("aria-label"));

    await user.click(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    );

    expect(
      screen
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.getAttribute("aria-label")),
    ).toEqual(labelsBefore);
    expect(viewport.scrollTop).toBe(80);
  });

  it("shows assigned channels in a bounded clickable table", async () => {
    const user = userEvent.setup();
    const assigned = Array.from({ length: 5 }, (_, index) => ({
      ...bindings[0],
      id: `assigned-${index + 1}`,
      channelId: `C-${index + 1}`,
      channelName: `Assigned channel ${index + 1}`,
    }));
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: assigned },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);

    render(<AgentChatAppsDetail agent={agent} />);

    expect(screen.getByText("Assigned channel 1")).toBeVisible();
    expect(screen.getByText("Assigned channel 5")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel Assigned channel 1",
      }),
    );
    const details = screen.getByRole("dialog", { name: "Assigned channel 1" });
    expect(
      within(details).getByRole("button", { name: "Save channel details" }),
    ).toBeDisabled();
    await user.click(
      within(details).getByRole("switch", { name: "Answer all messages" }),
    );
    await user.type(
      within(details).getByLabelText("Channel instructions"),
      "Reply with detail-page guidance.",
    );
    await user.click(
      within(details).getByRole("button", { name: "Save channel details" }),
    );
    expect(updateBinding).toHaveBeenCalledWith(
      {
        id: "assigned-1",
        answerAllMessages: true,
        channelInstructions: "Reply with detail-page guidance.",
      },
      { onSuccess: expect.any(Function) },
    );
    await user.click(
      within(details).getAllByRole("button", { name: "Close" })[0],
    );
  });

  it("keeps detail dialogs read-only without update permission", async () => {
    const user = userEvent.setup();
    hasUpdatePermission.mockReturnValue(false);
    render(<AgentChatAppsDetail agent={agent} />);

    await user.click(
      screen.getByRole("button", {
        name: "View details for Slack channel General",
      }),
    );
    const details = screen.getByRole("dialog", { name: "General" });
    expect(
      within(details).getByLabelText("Channel instructions"),
    ).toHaveAttribute("readonly");
    expect(
      within(details).queryByRole("button", { name: "Save channel details" }),
    ).toBeNull();
  });

  it("shows Telegram group channels as receiving all messages without updating reply behavior", async () => {
    const user = userEvent.setup();
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: {
        bindings: [
          {
            ...bindings[0],
            id: "telegram-channel",
            provider: "telegram",
            channelId: "telegram-group",
            channelName: "Telegram group",
            answerAllMessages: false,
          },
        ],
      },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);

    render(<AgentChatAppsDetail agent={agent} />);

    expect(screen.getByText("All messages")).toBeVisible();
    expect(screen.queryByText("Mentions only")).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Telegram channel Telegram group",
      }),
    );
    const details = screen.getByRole("dialog", { name: "Telegram group" });
    expect(
      within(details).queryByRole("switch", { name: "Answer all messages" }),
    ).toBeNull();
    await user.type(
      within(details).getByLabelText("Channel instructions"),
      "Use concise replies.",
    );
    await user.click(
      within(details).getByRole("button", { name: "Save channel details" }),
    );
    expect(updateBinding).toHaveBeenCalledWith(
      {
        id: "telegram-channel",
        channelInstructions: "Use concise replies.",
      },
      { onSuccess: expect.any(Function) },
    );
  });

  it("does not submit the enclosing Edit form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <AgentChatApps agent={agent} />
      </form>,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Search channels" }),
      "operations{Enter}",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "MS Teams channel Operations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "Move channel to Operations Agent?",
      }),
    ).toBeVisible();
  });

  it("disables all assignment controls for a read-only viewer", () => {
    render(<AgentChatApps agent={agent} readOnly />);

    expect(
      screen.getByRole("textbox", { name: "Search channels" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeDisabled();
  });

  it("disables pending direct messages without trigger-create permission", () => {
    hasCreatePermission.mockReturnValue(false);

    render(<AgentChatApps agent={agent} />);

    const directMessage = screen.getByRole("checkbox", {
      name: "Slack direct message",
    });
    expect(directMessage).toBeDisabled();
    expect(directMessage).toHaveAccessibleDescription(
      "You do not have permission to create a direct message assignment.",
    );
  });

  it("edits channel behavior and instructions from one details dialog", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgentChatApps agent={agent} />);

    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel General",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "General" });
    await user.click(
      within(dialog).getByRole("switch", { name: "Answer all messages" }),
    );
    await user.type(
      within(dialog).getByLabelText("Channel instructions"),
      "Handle priority requests.",
    );
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: bindings.map((binding) => ({ ...binding })) },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    rerender(<AgentChatApps agent={agent} />);

    expect(within(dialog).getByLabelText("Channel instructions")).toHaveValue(
      "Handle priority requests.",
    );
    expect(
      within(dialog).getByRole("switch", { name: "Answer all messages" }),
    ).toBeChecked();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Done",
      }),
    );

    expect(updateBinding).not.toHaveBeenCalled();
    expect(screen.getByText("Changes pending")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeEnabled();
    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel General",
      }),
    );
    expect(screen.getByLabelText("Channel instructions")).toHaveValue(
      "Handle priority requests.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );
    expect(applyBindingPlan).toHaveBeenCalledWith(
      {
        targetAgentId: "agent-1",
        updates: [
          {
            bindingId: "binding-1",
            expectedAgentId: "agent-1",
            nextAgentId: "agent-1",
            answerAllMessages: true,
            channelInstructions: "Handle priority requests.",
          },
        ],
        directMessages: [],
      },
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      }),
    );
  });

  it("reports unsaved assignments to the wizard", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    render(<AgentChatApps agent={agent} onDirtyChange={onDirtyChange} />);

    await user.click(
      screen.getByRole("checkbox", { name: "MS Teams channel Operations" }),
    );

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(
      screen.getByText("Save the channel changes before you continue."),
    ).toBeVisible();
  });

  it("registers channel persistence with the parent form without rendering a separate save", async () => {
    const user = userEvent.setup();
    let saveChanges: (() => Promise<boolean>) | null = null;
    render(
      <AgentChatApps
        agent={agent}
        standaloneSave={false}
        onSaveHandlerChange={(handler) => {
          saveChanges = handler;
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Save channel changes" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    );
    await waitFor(() => expect(saveChanges).not.toBeNull());

    let saved = false;
    await act(async () => {
      saved = (await saveChanges?.()) ?? false;
    });

    expect(saved).toBe(true);
    expect(applyBindingPlan).toHaveBeenCalled();
  });

  it("saves a new assignment and its staged settings in one request", async () => {
    const user = userEvent.setup();
    const unassigned = {
      ...bindings[0],
      id: "binding-3",
      channelId: "C3",
      channelName: "Escalations",
      agentId: null,
    };
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: [...bindings, unassigned] },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    render(<AgentChatApps agent={agent} />);

    await user.click(
      screen.getByRole("checkbox", { name: "Slack channel Escalations" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel Escalations",
      }),
    );
    await user.click(
      screen.getByRole("switch", { name: "Answer all messages" }),
    );
    await user.type(
      screen.getByLabelText("Channel instructions"),
      "Escalate urgent requests.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(applyBindingPlan).toHaveBeenCalledWith(
      {
        targetAgentId: "agent-1",
        updates: [
          {
            bindingId: "binding-3",
            expectedAgentId: null,
            nextAgentId: "agent-1",
            answerAllMessages: true,
            channelInstructions: "Escalate urgent requests.",
          },
        ],
        directMessages: [],
      },
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      }),
    );
  });

  it("drops staged settings when their new assignment is unchecked", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    const channel = screen.getByRole("checkbox", {
      name: "MS Teams channel Operations",
    });
    await user.click(channel);
    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for MS Teams channel Operations",
      }),
    );
    await user.type(
      screen.getByLabelText("Channel instructions"),
      "Temporary draft.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Changes pending")).toBeVisible();

    await user.click(channel);

    expect(screen.queryByText("Changes pending")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeDisabled();
  });

  it("does not offer chat apps that the organization turned off", () => {
    isChannelHidden.mockImplementation((provider) => provider === "telegram");

    render(<AgentChatApps agent={agent} />);

    expect(
      screen.queryByRole("link", { name: /Telegram/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Slack\s*Connected/ }),
    ).toBeVisible();
  });

  it("does not offer Email when the organization turned it off", () => {
    isChannelHidden.mockImplementation((provider) => provider === "email");

    render(<AgentChatAppsDetail agent={agent} />);

    expect(screen.queryByRole("link", { name: /Email/ })).toBeNull();
  });

  it("keeps Email available when every chat provider is hidden", () => {
    isChannelHidden.mockImplementation((provider) => provider !== "email");

    render(<AgentChatApps agent={agent} />);

    expect(
      screen.getByRole("button", {
        name: "Enable email for Email channel operations@example.com",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Email\s*Connected/ }),
    ).toBeVisible();
  });

  it("uses agent permission for Email and trigger permission for chat channels", async () => {
    const user = userEvent.setup();
    hasAgentUpdatePermission.mockReturnValue(false);
    const emailAgent = {
      id: "agent-1",
      name: "Operations Agent",
      scope: "org",
      authorId: "user-1",
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
    } as never;

    render(<AgentChatAppsDetail agent={emailAgent} />);

    expect(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel General",
      }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "View details for Email channel operations@example.com",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Email settings" })).toBeNull();
  });

  it("shows an error instead of marking unknown provider status as disconnected", () => {
    vi.mocked(useChatOpsStatus).mockReturnValue({
      data: undefined,
      isPending: false,
      isLoadingError: true,
      refetch: refetchProviders,
    } as never);

    render(<AgentChatApps agent={agent} />);

    expect(screen.getByText("Cannot load chat app status")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Slack\s*Set up/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Set up/ })).toBeNull();
  });

  it("shows an error when chat app availability cannot load", () => {
    vi.mocked(useConfig).mockReturnValue({
      data: undefined,
      isPending: false,
      isLoadingError: true,
      refetch: vi.fn(),
    } as never);

    render(<AgentChatApps agent={agent} />);

    expect(screen.getByText("Cannot load chat app availability")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Manage channels" }),
    ).not.toBeInTheDocument();
  });

  it("names the current agent and confirms before reassigning its channel", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    expect(screen.getByText("Operations")).toBeVisible();
    const ownerLink = screen.getByRole("link", { name: "Incident Agent" });
    expect(ownerLink).toHaveAttribute("href", "/agents/agent-2");
    expect(ownerLink.querySelector("img, svg")).not.toBeNull();
    expect(
      screen.getByRole("checkbox", {
        name: "MS Teams channel Operations",
      }),
    ).toHaveAccessibleDescription("Assigned to Incident Agent.");
    await user.click(
      screen.getByRole("checkbox", {
        name: "MS Teams channel Operations",
      }),
    );
    expect(
      screen.getByRole("checkbox", {
        name: "MS Teams channel Operations",
      }),
    ).toHaveAccessibleDescription(
      "Save moves this channel from Incident Agent to Operations Agent.",
    );
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Move channel to Operations Agent?",
    });
    expect(dialog).toHaveTextContent(
      "Each messaging channel can be assigned to only one agent at a time.",
    );
    expect(dialog).toHaveTextContent(
      "The current agent will stop receiving messages from this channel.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    expect(within(dialog).getByText("Operations")).toBeVisible();
    expect(within(dialog).getByText("Incident Agent")).toBeVisible();
    expect(within(dialog).getAllByText("Operations Agent")).toHaveLength(2);
    expect(within(dialog).queryByRole("link")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Operations" }),
    ).toBeNull();
    expect(applyBindingPlan).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("checkbox", {
        name: "MS Teams channel Operations",
      }),
    ).toBeChecked();
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );
    await user.click(screen.getByRole("button", { name: "Move channel" }));

    await waitFor(() => {
      expect(applyBindingPlan).toHaveBeenCalledWith(
        {
          targetAgentId: "agent-1",
          updates: [
            {
              bindingId: "binding-2",
              expectedAgentId: "agent-2",
              nextAgentId: "agent-1",
            },
          ],
          directMessages: [],
        },
        expect.objectContaining({
          onError: expect.any(Function),
          onSuccess: expect.any(Function),
        }),
      );
    });
  });

  it("unassigns this agent's channel without showing a reassignment warning", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    await user.click(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toHaveAccessibleDescription(
      "Save removes this channel from Operations Agent.",
    );
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(
      screen.queryByRole("dialog", { name: /Move/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(applyBindingPlan).toHaveBeenCalledWith(
        {
          targetAgentId: "agent-1",
          updates: [
            {
              bindingId: "binding-1",
              expectedAgentId: "agent-1",
              nextAgentId: null,
            },
          ],
          directMessages: [],
        },
        expect.objectContaining({
          onError: expect.any(Function),
          onSuccess: expect.any(Function),
        }),
      );
    });
  });

  it("guards a new direct-message assignment against concurrent creation", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const newDmBinding = {
      ...bindings[0],
      id: "new-dm",
      channelId: "D-new",
      channelName: "Direct message",
      isDm: true,
      dmOwnerEmail: "admin@example.com",
    };
    applyBindingPlan.mockImplementationOnce((_body, options) =>
      options?.onSuccess?.([newDmBinding]),
    );
    const { rerender } = render(
      <AgentChatApps agent={agent} onDirtyChange={onDirtyChange} />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Slack direct message" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Slack direct message" }),
    ).toHaveAccessibleDescription(
      "Save creates a direct message for Operations Agent.",
    );
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    await waitFor(() => {
      expect(applyBindingPlan).toHaveBeenCalledWith(
        {
          targetAgentId: "agent-1",
          updates: [],
          directMessages: [{ provider: "slack" }],
        },
        expect.objectContaining({
          onError: expect.any(Function),
          onSuccess: expect.any(Function),
        }),
      );
    });
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: [...bindings, newDmBinding] },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    rerender(<AgentChatApps agent={agent} onDirtyChange={onDirtyChange} />);

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(
      screen.getByRole("checkbox", { name: "Slack direct message" }),
    ).toBeChecked();
  });

  it("stops a reassignment when the channel owner changes before confirmation", async () => {
    const user = userEvent.setup();
    refetchBindings.mockResolvedValueOnce({
      data: {
        bindings: bindings.map((binding) =>
          binding.id === "binding-2"
            ? { ...binding, agentId: "agent-3" }
            : binding,
        ),
      },
      isError: false,
    });
    render(<AgentChatApps agent={agent} />);

    await user.click(
      screen.getByRole("checkbox", { name: "MS Teams channel Operations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );
    await user.click(screen.getByRole("button", { name: "Move channel" }));

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "MS Teams channel Operations" }),
      ).not.toBeChecked(),
    );
    expect(applyBindingPlan).not.toHaveBeenCalled();
  });

  it("preserves the selected assignment when the atomic save fails", async () => {
    const user = userEvent.setup();
    const unassigned = {
      ...bindings[0],
      id: "binding-3",
      channelId: "C3",
      channelName: "Escalations",
      agentId: null,
    };
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: [...bindings, unassigned] },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    applyBindingPlan.mockImplementationOnce((_body, options) =>
      options?.onError?.(new Error("Save failed")),
    );
    render(<AgentChatApps agent={agent} />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Slack channel Escalations",
    });
    await user.click(checkbox);
    expect(checkbox).toHaveAccessibleDescription(
      "Save assigns this channel to Operations Agent.",
    );
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(applyBindingPlan).toHaveBeenCalled();
    expect(refetchBindings).not.toHaveBeenCalled();
    expect(checkbox).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeEnabled();
  });

  it("preserves staged channel details when the atomic save fails", async () => {
    const user = userEvent.setup();
    applyBindingPlan.mockImplementationOnce((_body, options) =>
      options?.onError?.(new Error("Save failed")),
    );
    render(<AgentChatApps agent={agent} />);

    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel General",
      }),
    );
    await user.type(
      screen.getByLabelText("Channel instructions"),
      "Keep this draft.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(screen.getByText("Changes pending")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Edit channel for Slack channel General",
      }),
    );
    expect(screen.getByLabelText("Channel instructions")).toHaveValue(
      "Keep this draft.",
    );
  });

  it("summarizes a multi-channel reassignment", async () => {
    const user = userEvent.setup();
    const manyBindings = [
      bindings[0],
      ...Array.from({ length: 4 }, (_, index) => ({
        ...bindings[1],
        id: `binding-${index + 2}`,
        channelId: `C${index + 2}`,
        channelName: `Operations ${index + 1}`,
      })),
    ];
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: manyBindings },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    render(<AgentChatApps agent={agent} />);

    for (let index = 1; index <= 4; index += 1) {
      await user.click(
        screen.getByRole("checkbox", {
          name: `MS Teams channel Operations ${index}`,
        }),
      );
    }
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Move 4 channels to Operations Agent?",
    });
    expect(within(dialog).getAllByText("Incident Agent")).toHaveLength(4);
    expect(within(dialog).getAllByText("Operations Agent")).toHaveLength(5);
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("shows an error when assigned agent names cannot load", () => {
    vi.mocked(useProfiles).mockReturnValue({
      data: undefined,
      isPending: false,
      isLoadingError: true,
      refetch: refetchAgentNames,
    } as never);
    render(<AgentChatApps agent={agent} />);

    expect(
      screen.getByText("Cannot load the agents assigned to these channels"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save channel changes" }),
    ).not.toBeInTheDocument();
  });

  it("does not wait for agent names when no channel belongs to another agent", () => {
    vi.mocked(useProfiles).mockReturnValue({
      data: undefined,
      isPending: true,
      isLoadingError: false,
      refetch: refetchAgentNames,
    } as never);
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: [bindings[0]] },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    render(<AgentChatApps agent={agent} />);

    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toBeVisible();
  });

  it("keeps unsupported personal-agent channels visible but disabled", () => {
    render(
      <AgentChatApps
        agent={
          {
            id: "agent-1",
            name: "Personal Agent",
            scope: "personal",
            authorId: "user-1",
          } as never
        }
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Slack channel General" }),
    ).toHaveAccessibleDescription(
      "This personal agent can use only its owner's direct messages.",
    );
    expect(
      screen.getAllByText(
        "This personal agent can use only its owner's direct messages.",
      ),
    ).not.toHaveLength(0);
  });
});
