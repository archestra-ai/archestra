import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { AgentChatAppsEditor as AgentChatApps } from "./agent-chat-apps";

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

/**
 * Claiming a channel goes through the picker now: there is no checkbox list of
 * the whole pool, so a test clicks Add channel, switches provider if it needs
 * one that is not the default, and picks the row.
 */
async function addChannel(
  user: ReturnType<typeof userEvent.setup>,
  channelName: string,
  provider?: string,
) {
  await openPicker(user, provider);
  // A claimed row's accessible name carries "Answered by ..." after the
  // channel, so match the start rather than the whole string.
  await user.click(
    await screen.findByRole("button", {
      name: new RegExp(`^${channelName}`),
    }),
  );
}

/** One assigned row, by the channel it holds. */
function channelRow(channelName: string) {
  // A direct message's row is labelled "<Provider> direct message", so match
  // case-insensitively rather than making every caller know the casing.
  return screen.getByRole("listitem", {
    name: new RegExp(`${channelName}$`, "i"),
  });
}

/** Opening the picker, optionally on a provider other than the first. */
async function openPicker(
  user: ReturnType<typeof userEvent.setup>,
  provider?: string,
) {
  await user.click(screen.getByRole("button", { name: /add channel/i }));
  if (provider) {
    await user.click(await screen.findByRole("button", { name: provider }));
  }
}

/** Dropping one this agent already holds, from its row. */
async function removeChannel(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  await user.click(screen.getByRole("button", { name: `Remove ${label}` }));
}

beforeAll(() => {
  // The add-channel picker is a Radix Popover, which reaches for APIs jsdom
  // does not implement.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

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

  it("names the agent holding a channel, without linking one it cannot read", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    await openPicker(user, "MS Teams");
    expect(
      await screen.findByRole("button", {
        name: /^OperationsAnswered by Incident Agent/,
      }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "Incident Agent" })).toBeNull();
  });

  it("falls back to a placeholder when the holding agent cannot be read", async () => {
    const user = userEvent.setup();
    vi.mocked(useProfiles).mockReturnValue({
      data: [],
      isPending: false,
      isLoadingError: false,
      refetch: refetchAgentNames,
    } as never);
    render(<AgentChatApps agent={agent} />);

    await openPicker(user, "MS Teams");
    expect(
      await screen.findByRole("button", {
        name: /^OperationsAnswered by another agent/,
      }),
    ).toBeVisible();
  });

  it("lists the channels this agent holds, and offers a way to add more", () => {
    render(<AgentChatApps agent={agent} />);

    // The agent's own channels, not the organization's whole pool: General is
    // assigned here, Operations belongs to another agent and is not listed.
    expect(screen.getByText("General")).toBeVisible();
    expect(screen.queryByText("Operations")).toBeNull();
    expect(screen.getByRole("button", { name: "Add channel" })).toBeVisible();
    // No provider strip: a connected provider needs no announcement.
    expect(
      screen.queryByRole("link", { name: /Slack\s*Connected/ }),
    ).toBeNull();
  });

  it("points at the provider holding a channel the search found elsewhere", async () => {
    const user = userEvent.setup();
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: {
        bindings: [
          ...bindings,
          {
            ...bindings[0],
            id: "binding-3",
            channelId: "C3",
            channelName: "Escalations",
            agentId: null,
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
    render(<AgentChatApps agent={agent} />);

    // The picker opens on the first connected provider — MS Teams here — but
    // Escalations is a Slack room, so the search must say where it went.
    await openPicker(user);
    await user.type(
      screen.getByRole("textbox", { name: "Search channels" }),
      "Escalations",
    );

    expect(screen.getByText(/No MS Teams channels match/)).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "1 in Slack" }));

    expect(
      await screen.findByRole("button", { name: /^Escalations/ }),
    ).toBeVisible();
  });

  it("says so when a provider has nothing left to add", async () => {
    const user = userEvent.setup();
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: {
        bindings: [
          bindings[0],
          // A direct message already exists and is already ours, so Slack has
          // neither a room nor a DM left to offer.
          {
            ...bindings[0],
            id: "binding-dm",
            channelId: "D1",
            channelName: "Direct message",
            isDm: true,
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
    render(<AgentChatApps agent={agent} />);

    await openPicker(user);

    expect(
      screen.getByText("Every channel here is already assigned to this agent."),
    ).toBeVisible();
  });

  it("opens a channel's settings from its row", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("dialog", { name: "General" })).toBeVisible();
  });

  it("does not submit the enclosing Edit form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <AgentChatApps agent={agent} />
      </form>,
    );

    await addChannel(user, "Operations", "MS Teams");
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "Change the agent for this channel?",
      }),
    ).toBeVisible();
  });

  it("offers a read-only viewer no way to change the assignments", () => {
    render(<AgentChatApps agent={agent} readOnly />);

    expect(screen.getByText("General")).toBeVisible();
    expect(screen.getByRole("button", { name: "View details" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add channel" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeDisabled();
  });

  it("folds a direct message it cannot create into the unavailable group", async () => {
    const user = userEvent.setup();
    hasCreatePermission.mockReturnValue(false);

    render(<AgentChatApps agent={agent} />);

    await openPicker(user, "Slack");
    // Not offered as something to click...
    expect(
      screen.queryByRole("button", { name: /^Direct message/ }),
    ).toBeNull();
    // ...but still reachable, under one line that says how many and why.
    const group = await screen.findByRole("button", {
      name: /1 not available to this agent/,
    });
    expect(group).toHaveTextContent(
      "You do not have permission to create a direct message assignment.",
    );
    expect(group).toHaveAttribute("aria-expanded", "false");

    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Direct message")).toBeVisible();
  });

  it("edits channel behavior and instructions from one details dialog", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgentChatApps agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
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
    await user.click(screen.getByRole("button", { name: "Settings" }));
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

    await addChannel(user, "Operations", "MS Teams");

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
    await removeChannel(user, "Slack channel General");
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

    await addChannel(user, "Escalations", "Slack");
    await user.click(
      within(channelRow("Escalations")).getByRole("button", {
        name: "Settings",
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

    await addChannel(user, "Operations", "MS Teams");
    await user.click(
      within(channelRow("Operations")).getByRole("button", {
        name: "Settings",
      }),
    );
    await user.type(
      screen.getByLabelText("Channel instructions"),
      "Temporary draft.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Changes pending")).toBeVisible();

    await removeChannel(user, "MS Teams channel Operations");

    expect(screen.queryByText("Changes pending")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save channel changes" }),
    ).toBeDisabled();
  });

  it("does not offer chat apps that the organization turned off", async () => {
    const user = userEvent.setup();
    isChannelHidden.mockImplementation((provider) => provider === "telegram");

    render(<AgentChatApps agent={agent} />);

    await openPicker(user);
    expect(screen.getByRole("button", { name: "Slack" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Telegram/ })).toBeNull();
  });

  it("keeps Email available when every chat provider is hidden", () => {
    isChannelHidden.mockImplementation((provider) => provider !== "email");

    render(<AgentChatApps agent={agent} />);

    expect(screen.getByRole("button", { name: "Turn on" })).toBeVisible();
    // Nothing to pick from, so the channel section says nothing at all.
    expect(screen.queryByText("Channels")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add channel" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Add channel" })).toBeNull();
    expect(screen.queryByText("No messaging providers connected")).toBeNull();
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

    // Another agent's channel is not listed here until it is claimed.
    expect(screen.queryByText("Operations")).toBeNull();
    await addChannel(user, "Operations", "MS Teams");
    // Claimed but not yet saved, and the row says whose it still is.
    expect(
      within(channelRow("Operations")).getByText(
        "Takes over from Incident Agent",
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Change the agent for this channel?",
    });
    expect(dialog).toHaveTextContent(
      "A channel answers with one agent at a time.",
    );
    expect(dialog).toHaveTextContent(
      "The current agent will stop answering in this channel.",
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
    // Cancelling drops the transfer, not the staged claim.
    expect(channelRow("Operations")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );
    await user.click(screen.getByRole("button", { name: "Change agent" }));

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

    await removeChannel(user, "Slack channel General");
    expect(screen.queryByText("General")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(
      screen.queryByRole("dialog", { name: /Change the agent/ }),
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

    await addChannel(user, "Direct message", "Slack");
    expect(
      within(channelRow("Direct message")).getByText("New direct message"),
    ).toBeVisible();
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
    // Saved: the same direct message, now a real binding rather than a claim —
    // and named by its owner, which is the only thing telling two apart.
    const saved = channelRow("Slack direct message for admin@example.com");
    expect(
      within(saved).getByText("Direct message (admin@example.com)"),
    ).toBeVisible();
    expect(screen.queryByText("New direct message")).toBeNull();
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

    await addChannel(user, "Operations", "MS Teams");
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );
    await user.click(screen.getByRole("button", { name: "Change agent" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("listitem", {
          name: "MS Teams channel Operations",
        }),
      ).toBeNull(),
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

    await addChannel(user, "Escalations", "Slack");
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    expect(applyBindingPlan).toHaveBeenCalled();
    expect(refetchBindings).not.toHaveBeenCalled();
    expect(channelRow("Escalations")).toBeVisible();
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
      within(channelRow("General")).getByRole("button", { name: "Settings" }),
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
      within(channelRow("General")).getByRole("button", { name: "Settings" }),
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
      await addChannel(user, `Operations ${index}`, "MS Teams");
    }
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Change the agent for 4 channels?",
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

    expect(channelRow("General")).toBeVisible();
  });

  it("states a personal agent's refusal once instead of once per channel", async () => {
    const user = userEvent.setup();
    const pool = Array.from({ length: 6 }, (_, index) => ({
      ...bindings[0],
      id: `shared-${index}`,
      channelId: `CS${index}`,
      channelName: `shared-${index}`,
      agentId: null,
    }));
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: pool },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
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

    await openPicker(user, "Slack");
    const reason =
      "This personal agent can use only its owner's direct messages.";
    // One sentence for the whole pool, not one per row — six copies of it was
    // the loudest thing on the page.
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /6 not available to this agent/ }),
    ).toBeVisible();
    for (const binding of pool) {
      expect(
        screen.queryByRole("button", {
          name: new RegExp(`^${binding.channelName}`),
        }),
      ).toBeNull();
    }

    // Searching finds them in the group rather than claiming nothing matched.
    await user.type(screen.getByLabelText("Search channels"), "shared-3");
    expect(screen.queryByText("No channels match.")).toBeNull();
    expect(
      screen.getByRole("button", { name: /1 not available to this agent/ }),
    ).toBeVisible();
  });

  it("titles a direct message's settings by its owner, not its provider id", async () => {
    const user = userEvent.setup();
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: {
        bindings: [
          {
            ...bindings[0],
            id: "binding-dm",
            channelId: "19:dm000001@thread.tacv2",
            channelName: null,
            isDm: true,
            dmOwnerEmail: "admin@example.com",
            agentId: "agent-1",
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
    render(<AgentChatApps agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Direct message (admin@example.com)",
    });
    // The raw id belongs in the fact list, not in the heading.
    expect(within(dialog).getByText("Chat ID")).toBeVisible();
    expect(dialog).toHaveTextContent("for messages from this direct message.");
  });

  it("names the direct message a transfer is about, and calls it one", async () => {
    const user = userEvent.setup();
    const dmBinding = {
      ...bindings[0],
      id: "binding-dm",
      channelId: "D1",
      channelName: null,
      isDm: true,
      dmOwnerEmail: "admin@example.com",
      agentId: "agent-2",
    };
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings: [dmBinding] },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchBindings,
    } as never);
    refetchBindings.mockResolvedValue({
      data: { bindings: [dmBinding] },
      isError: false,
    });
    render(<AgentChatApps agent={agent} />);

    await addChannel(user, "Direct message \\(admin@example.com\\)", "Slack");
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );

    // A direct message is not a channel, and "which one" has an answer.
    const dialog = screen.getByRole("dialog", {
      name: "Change the agent for this direct message?",
    });
    expect(dialog).toHaveTextContent(
      "A direct message answers with one agent at a time.",
    );
    expect(
      within(dialog).getByText("Direct message (admin@example.com)"),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Change agent" }),
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

    // Still listed, because it is still assigned — but a personal agent
    // cannot let go of it either, so the row's control is refused.
    expect(
      within(channelRow("General")).getByRole("button", {
        name: "Remove Slack channel General",
      }),
    ).toBeDisabled();
  });
});
