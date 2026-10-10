import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AgentWorkSources } from "./agent-work-sources";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
}));
vi.mock("@/lib/agent-runtime.query", () => ({
  useAgentRuntimePreflight: vi.fn(),
}));

function mockBindings(
  bindings: Array<{
    id: string;
    agentId: string | null;
    provider: "slack" | "ms-teams" | "telegram";
    channelId: string;
    channelName: string | null;
  }>,
) {
  vi.mocked(useAllChatOpsBindings).mockReturnValue({
    data: { bindings },
    isPending: false,
  } as unknown as ReturnType<typeof useAllChatOpsBindings>);
}

function mockSetupReady(ready: boolean) {
  vi.mocked(useAgentRuntimePreflight).mockReturnValue({
    data: { ready },
  } as unknown as ReturnType<typeof useAgentRuntimePreflight>);
}

beforeEach(() => {
  mockSetupReady(true);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  mockBindings([]);
});

describe("AgentWorkSources", () => {
  it("offers a coding agent chat, handoff from a laptop, and its channels", () => {
    mockBindings([
      {
        id: "b1",
        agentId: "a1",
        provider: "slack",
        channelId: "C1",
        channelName: "eng-platform",
      },
      {
        id: "b2",
        agentId: "someone-else",
        provider: "slack",
        channelId: "C2",
        channelName: "support",
      },
    ]);
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        showsA2a
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Give it work" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open in chat" })).toHaveAttribute(
      "href",
      "/chat?agentId=a1",
    );
    expect(
      screen.getByRole("link", { name: "Connect your local agent" }),
    ).toHaveAttribute("href", "/connection");
    // Only this agent's channels, not every channel in the workspace.
    const channels = screen
      .getByRole("heading", { level: 3, name: "In your channels" })
      .closest("div")?.parentElement as HTMLElement;
    expect(within(channels).getByText(/eng-platform/)).toBeVisible();
    expect(within(channels).queryByText(/support/)).toBeNull();
    expect(
      within(channels).getByRole("link", { name: "Manage channels" }),
    ).toHaveAttribute("href", "/agents/a1?section=messaging");
    // A coding agent already has a runtime: nothing to offer there.
    expect(
      screen.queryByRole("link", { name: "Set up Agent Runtime" }),
    ).toBeNull();
  });

  it("offers an agent on the built-in harness A2A and a dedicated runtime", () => {
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime={false}
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        showsA2a
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Where people use it" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Connect your local agent" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "A2A details" })).toHaveAttribute(
      "href",
      "/agents/a1?section=connect",
    );
    expect(screen.getByRole("link", { name: "Add a channel" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Set up Agent Runtime" }),
    ).toHaveAttribute("href", "/agents/a1?section=runtime");
  });

  it("says a coding agent's routes wait on its setup until the setup is done", () => {
    mockSetupReady(false);
    const { rerender } = render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        showsA2a
      />,
    );
    expect(
      screen.getByText("Available once setup above is done."),
    ).toBeVisible();

    mockSetupReady(true);
    rerender(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        showsA2a
      />,
    );
    expect(
      screen.queryByText("Available once setup above is done."),
    ).toBeNull();
  });

  it("hides channels from a reader who cannot see them", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable={false}
        chatHref={null}
        showsA2a
      />,
    );
    expect(
      screen.queryByRole("heading", { level: 3, name: "In your channels" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in chat" })).toBeNull();
  });
});
