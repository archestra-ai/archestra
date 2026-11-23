import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentSavedSetupBanner } from "./agent-saved-setup-banner";

describe("saved agent setup notices", () => {
  it("lists what the agent still needs without the Claude sign-in or a progress bar, and ticks off what resolves", async () => {
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
        { key: "OTHER_TOKEN", label: "Other token" },
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
    // The person's Claude sign-in belongs to the Account strip under
    // "Give it work", so the checklist leaves it out.
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Claude subscription")).not.toBeInTheDocument();
    expect(screen.queryByText("Before it runs")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("API token")).toBeVisible();
    await act(async () => {
      client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
        ...preflight,
        missing: [preflight.missing[0], preflight.missing[2]],
      });
    });
    // A row resolved while the page is open stays, ticked.
    await waitFor(() =>
      expect(
        within(
          screen.getByText("API token").closest("li") as HTMLElement,
        ).getByText("Done"),
      ).toBeVisible(),
    );
    await act(async () => {
      client.setQueryData(["agents", "agent-1", "runtime", "preflight"], {
        ...preflight,
        missing: [],
        ready: true,
      });
    });
    client.clear();
  });

  it("collapses admin-only credentials into one row and hides what the member cannot use", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
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
      /not supported/,
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    expect(screen.queryByText(/internet connection/)).toBeNull();
  });

  it.each([
    "archestra-codex",
    "archestra-codex-runtime",
  ])("leaves the ChatGPT sign-in of an %s agent to its account card, and lists only what the setup check reports", (command) => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    // Nobody here has a ChatGPT key, and neither agent has one selected: the
    // strip said so once, and now stays out of the person's subscription.
    const renderStrip = (agentId: string, missing: object[]) => {
      client.setQueryData(["agents", agentId], {
        id: agentId,
        runtime: { command: [command], credentials: [] },
      });
      client.setQueryData(["agents", agentId, "runtime", "preflight"], {
        ready: missing.length === 0,
        configured: [],
        misconfigured: [],
        incompatible: null,
        missing,
      });
      return render(
        <QueryClientProvider client={client}>
          <AgentSavedSetupBanner agentId={agentId} canEditAgent />
        </QueryClientProvider>,
      );
    };

    const waiting = renderStrip("agent-waiting", [
      { key: "API_TOKEN", label: "API token" },
    ]);
    expect(screen.getByText("API token")).toBeVisible();
    expect(screen.queryByText(/ChatGPT/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    waiting.unmount();

    // With nothing missing there is no strip at all.
    const ready = renderStrip("agent-ready", []);
    expect(ready.container).toBeEmptyDOMElement();
    client.clear();
  });
});
