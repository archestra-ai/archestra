import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bulkUpdate = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
  useChatOpsStatus: () => ({
    data: [
      { id: "slack", configured: true },
      { id: "ms-teams", configured: true },
    ],
  }),
  useBulkUpdateChatOpsBindings: () => ({
    mutateAsync: bulkUpdate,
    isPending: false,
  }),
  useCreateChatOpsDmBinding: () => ({
    mutateAsync: vi.fn().mockResolvedValue(null),
    isPending: false,
  }),
  useUpdateChatOpsBinding: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/standard-dialog", () => ({
  StandardDialog: ({
    open,
    children,
    footer,
  }: {
    open: boolean;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        {children}
        {footer}
      </div>
    ) : null,
}));

vi.mock("@/components/ui/multi-select-combobox", () => ({
  MultiSelectCombobox: ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    value: string[];
    onChange: (value: string[]) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          aria-pressed={value.includes(option.value)}
          onClick={() =>
            onChange(
              value.includes(option.value)
                ? value.filter((id) => id !== option.value)
                : [...value, option.value],
            )
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import { AgentChatApps } from "./agent-chat-apps";

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

describe("AgentChatApps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: { bindings },
      isPending: false,
      isLoadingError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    } as never);
  });

  it("shows the channels currently assigned to the agent", () => {
    render(<AgentChatApps agent={agent} />);

    expect(screen.getByText("General")).toBeVisible();
    expect(screen.queryByText("Operations")).toBeNull();
  });

  it("reassigns a selected channel to this agent", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Manage channels" }));
    await user.click(
      screen.getByRole("button", { name: "MS Teams · Operations" }),
    );
    await user.click(screen.getByRole("button", { name: "Save assignments" }));

    await waitFor(() => {
      expect(bulkUpdate).toHaveBeenCalledWith({
        ids: ["binding-2"],
        agentId: "agent-1",
      });
    });
    expect(bulkUpdate).not.toHaveBeenCalledWith({
      ids: ["binding-1"],
      agentId: null,
    });
  });

  it("unassigns a channel removed from this agent", async () => {
    const user = userEvent.setup();
    render(<AgentChatApps agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Manage channels" }));
    await user.click(screen.getByRole("button", { name: "Slack · General" }));
    await user.click(screen.getByRole("button", { name: "Save assignments" }));

    await waitFor(() => {
      expect(bulkUpdate).toHaveBeenCalledWith({
        ids: ["binding-1"],
        agentId: null,
      });
    });
  });
});
