import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AgentSavedSetupBanner } from "./agent-saved-setup-banner";

vi.mock("@/lib/auth/auth.query");

describe("saved agent setup notices", () => {
  it("lists Claude sign-in with the other setup rows and ticks off what resolves", async () => {
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
    // Claude sign-in is one row of the checklist, not a notice of its own.
    expect(
      screen.getAllByRole("button", { name: "Sign in with Claude" }),
    ).toHaveLength(1);
    expect(screen.getByText("Before this agent can run")).toBeVisible();
    expect(screen.getByText("Connect your Claude subscription")).toBeVisible();
    expect(screen.getByText("Provide API token")).toBeVisible();
    expect(screen.getByText("0 of 2 done")).toBeVisible();
    await act(async () => {
      client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
        ...preflight,
        missing: preflight.missing.slice(0, 1),
      });
    });
    // A row resolved while the page is open stays, ticked.
    expect(await screen.findByText("1 of 2 done")).toBeVisible();
    expect(
      within(
        screen.getByText("Provide API token").closest("li") as HTMLElement,
      ).getByText("Done"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    ).toBeVisible();
    await act(async () => {
      client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
        ...preflight,
        missing: [],
        ready: true,
      });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Sign in with Claude" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Before this agent can run"),
    ).not.toBeInTheDocument();
    client.clear();
  });

  it("collapses admin-only credentials into one row and hides what the member cannot use", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as never);
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    // A Codex agent, so the ChatGPT subscription row would normally show too.
    client.setQueryData(["agents", "agent-1"], {
      id: "agent-1",
      runtime: { command: ["archestra-codex"], credentials: [] },
    });
    const adminOnly = { canConnect: false, adminOnly: true };
    client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
      ready: false,
      configured: [],
      misconfigured: [],
      incompatible: "This model is not supported.",
      missing: [
        { key: "MIRROR", label: "Private mirror sync", ...adminOnly },
        { key: "NITPICK", label: "Nitpicker model-router key", ...adminOnly },
        {
          key: "GEMINI",
          label: "Gemini API key for demo narration",
          ...adminOnly,
        },
        { key: "GITHUB_TOKEN", label: "GitHub account" },
        { key: "CLAUDE_CODE_ACCOUNT", label: "Claude" },
      ],
    });
    render(
      <QueryClientProvider client={client}>
        <AgentSavedSetupBanner agentId="agent-1" canEditAgent={false} />
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("Only admins can run this agent")).toHaveLength(
      1,
    );
    expect(
      screen.getByText(
        "It uses Private mirror sync, Nitpicker model-router key and Gemini API key for demo narration from your organization. Ask an admin to run it for you or change its setup.",
      ),
    ).toBeVisible();
    for (const hidden of [
      /Provide GitHub account/,
      /Claude subscription/,
      /ChatGPT subscription/,
      /not supported/,
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    expect(screen.queryByText(/internet connection/)).toBeNull();
  });
});
