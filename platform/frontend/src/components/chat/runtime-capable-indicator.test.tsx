import { archestraApiSdk, getAgentCatalogImages } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  AgentRuntimeBadge,
  RuntimeCapableIndicator,
} from "./runtime-capable-indicator";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
vi.mock("@archestra/shared/api-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared/api-sdk")>()),
  listAgentRuntimeTemplates: vi.fn(),
}));

const sdk = vi.mocked(archestraApiSdk);
const catalogImages = getAgentCatalogImages({
  registry: "mirror.example.com/archestra",
  tag: "1.5.0",
});

const claudeCodeRuntime = {
  image: "registry.example/team/agent-claude-code:v2",
  command: ["archestra-claude-code"],
};
const customRuntime = {
  image: "ghcr.io/example/toolbox:latest",
  command: ["python", "loop.py"],
};

describe("RuntimeCapableIndicator", () => {
  beforeEach(() => {
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentRuntime" ? true : undefined,
    );
  });

  it("names a maintained template's runtime", () => {
    render(
      <RuntimeCapableIndicator variant="pill" runtime={claudeCodeRuntime} />,
    );

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("reads as a plain runtime for a custom image, with or without a command", () => {
    const { rerender } = render(
      <RuntimeCapableIndicator variant="pill" runtime={customRuntime} />,
    );
    expect(screen.getByText("Runtime")).toBeInTheDocument();

    rerender(
      <RuntimeCapableIndicator
        variant="pill"
        runtime={{ image: "ghcr.io/example/toolbox:latest", command: null }}
      />,
    );
    expect(screen.getByText("Runtime")).toBeInTheDocument();
  });

  it("renders nothing while the deployment's runtime feature is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);

    const { container } = render(
      <RuntimeCapableIndicator variant="pill" runtime={claudeCodeRuntime} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("AgentRuntimeBadge", () => {
  /** The organization's one custom runtime, with a long name of its own. */
  const teamRuntime = {
    id: "c0ffee00-0000-4000-8000-000000000001",
    name: "Platform engineering review workspace",
    description: "",
    icon: null,
    hidden: false,
    position: 0,
    image: "registry.example.com/platform/review:v3",
  };
  const onTeamRuntime = { image: teamRuntime.image, command: ["review-agent"] };
  /** A maintained image, on a command of the agent's own. */
  const onCodexImage = { image: catalogImages.codex, command: ["my-wrapper"] };
  /** An image none of the organization's runtimes runs. */
  const onOwnImage = { image: "ghcr.io/example/toolbox:latest", command: null };

  const clients: QueryClient[] = [];
  const mount = (ui: ReactNode) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    return render(
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
    );
  };
  /** Whether the reader may open Settings → Agents → Runtimes. */
  const administers = (allowed: boolean) =>
    vi.mocked(useHasPermissions).mockImplementation(((
      permissions: Record<string, string[]>,
    ) => ({
      data:
        allowed &&
        JSON.stringify(permissions) ===
          JSON.stringify({ organizationSettings: ["read"] }),
    })) as unknown as typeof useHasPermissions);

  beforeEach(() => {
    vi.mocked(useFeature).mockImplementation(((flag: string) =>
      flag === "agentRuntime"
        ? true
        : flag === "agentRuntimeCatalogImages"
          ? catalogImages
          : undefined) as unknown as typeof useFeature);
    vi.mocked(useRouter).mockReturnValue({
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    sdk.listAgentRuntimeTemplates.mockResolvedValue({
      data: [teamRuntime],
      error: undefined,
    } as never);
    administers(true);
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.clear();
    vi.clearAllMocks();
  });

  it("names a maintained runtime, a custom runtime and an image that is none of them, each linked to its settings", async () => {
    mount(
      <>
        <AgentRuntimeBadge runtime={onCodexImage} />
        <AgentRuntimeBadge runtime={claudeCodeRuntime} />
        <AgentRuntimeBadge runtime={onTeamRuntime} />
        <AgentRuntimeBadge runtime={onOwnImage} />
      </>,
    );

    // A maintained image is its runtime whatever command the agent sets, and
    // the link opens that runtime's editor.
    const codex = await screen.findByRole("link", {
      name: "Runtime: Codex, open its settings",
    });
    expect(codex).toHaveTextContent("Codex");
    expect(codex).toHaveAttribute(
      "href",
      "/settings/agents/runtimes?edit=codex",
    );
    // A maintained wrapper on another image is that runtime too.
    expect(
      await screen.findByRole("link", {
        name: "Runtime: Claude Code, open its settings",
      }),
    ).toHaveAttribute("href", "/settings/agents/runtimes?edit=claude-code");
    // A custom runtime shows by its own name, whole in its accessible name
    // however much of it the badge has room for.
    const custom = await screen.findByRole("link", {
      name: "Runtime: Platform engineering review workspace, open its settings",
    });
    expect(custom).toHaveTextContent("Platform engineering review workspace");
    expect(custom).toHaveAttribute(
      "href",
      `/settings/agents/runtimes?edit=${teamRuntime.id}`,
    );
    // No runtime to open: the link leads to the list of them.
    const unmatched = screen.getByRole("link", {
      name: "Runtime: Custom image, open runtime settings",
    });
    expect(unmatched).toHaveTextContent("Custom image");
    expect(unmatched).toHaveAttribute("href", "/settings/agents/runtimes");
  });

  it("reads the organization's runtimes once, however many agents show the badge", async () => {
    mount(
      <ul>
        {Array.from({ length: 12 }, (_, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed test list
          <li key={row}>
            <AgentRuntimeBadge runtime={onTeamRuntime} fallback="pill" />
          </li>
        ))}
      </ul>,
    );

    expect(
      await screen.findAllByRole("link", {
        name: "Runtime: Platform engineering review workspace, open its settings",
      }),
    ).toHaveLength(12);
    expect(sdk.listAgentRuntimeTemplates).toHaveBeenCalledTimes(1);
  });

  it("waits for the list before naming an image it cannot place, and names a maintained image at once", async () => {
    let answer!: () => void;
    sdk.listAgentRuntimeTemplates.mockReturnValue(
      new Promise((resolve) => {
        answer = () => resolve({ data: [teamRuntime], error: undefined });
      }) as never,
    );
    mount(
      <>
        <AgentRuntimeBadge runtime={onCodexImage} />
        <AgentRuntimeBadge runtime={onTeamRuntime} />
      </>,
    );

    expect(
      screen.getByRole("link", { name: "Runtime: Codex, open its settings" }),
    ).toBeInTheDocument();
    // Not "Custom image" first, then its runtime's name.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    answer();
    expect(
      await screen.findByRole("link", {
        name: "Runtime: Platform engineering review workspace, open its settings",
      }),
    ).toBeInTheDocument();
  });

  it("leaves someone who cannot open the runtime settings with the mark they had, and asks for nothing", async () => {
    administers(false);
    mount(
      <>
        <AgentRuntimeBadge runtime={claudeCodeRuntime} fallback="icon" />
        <AgentRuntimeBadge runtime={onTeamRuntime} fallback="pill" />
      </>,
    );

    // The icon and the pill, as before: no link, and no custom name.
    expect(
      screen.getByRole("button", { name: "Runtime: Claude Code" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.queryByText("Platform engineering review workspace"),
    ).toBeNull();
    await waitFor(() =>
      expect(sdk.listAgentRuntimeTemplates).not.toHaveBeenCalled(),
    );
  });

  it("shows nothing to them where the spot had no mark, and nothing at all while the runtime feature is off", () => {
    administers(false);
    const without = mount(<AgentRuntimeBadge runtime={claudeCodeRuntime} />);
    expect(without.container).toBeEmptyDOMElement();
    without.unmount();

    administers(true);
    vi.mocked(useFeature).mockReturnValue(false);
    const off = mount(
      <AgentRuntimeBadge runtime={claudeCodeRuntime} fallback="pill" />,
    );
    expect(off.container).toBeEmptyDOMElement();
  });
});
