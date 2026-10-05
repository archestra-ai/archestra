import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AgentSavedSetupBanner } from "./agent-saved-setup-banner";

vi.mock("@/lib/auth/auth.query");

describe("saved agent setup notices", () => {
  it("shows one Claude sign-in notice and removes completed setup history", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as never);
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(["agents", "agent-1"], {
      id: "agent-1",
      runtime: { command: ["archestra-claude-code"], credentials: [] },
    });
    client.setQueryData(["claude-code-account", "agent-1"], {
      state: "disconnected",
    });
    const preflight = {
      ready: false,
      configured: [],
      misconfigured: [],
      incompatible: null,
      missing: [
        { key: "CLAUDE_CODE_ACCOUNT", label: "Claude" },
        { key: "API_TOKEN", label: "API token" },
      ],
    };
    client.setQueryData(
      ["agents", "agent-1", "runtime", "preflight"],
      preflight,
    );
    render(
      <QueryClientProvider client={client}>
        <AgentSavedSetupBanner agentId="agent-1" canEditAgent />
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.getByText("Before this agent can run")).toBeVisible();
    await act(async () => {
      client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
        ...preflight,
        missing: preflight.missing.slice(0, 1),
      });
    });
    expect(screen.getByText("Sign in to use this agent.")).toBeVisible();
    expect(screen.queryByText("Ready to run.")).not.toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("Before this agent can run"),
      ).not.toBeInTheDocument(),
    );
    await act(async () => {
      client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
        ...preflight,
        missing: [],
        ready: true,
      });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Sign in" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Ready to run.")).not.toBeInTheDocument();
    client.clear();
  });
});
