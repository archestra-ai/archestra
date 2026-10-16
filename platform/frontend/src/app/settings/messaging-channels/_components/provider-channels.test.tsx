import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import { ProviderChannels } from "./provider-channels";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
  useUpdateChatOpsBinding: vi.fn(),
}));
vi.mock("./channel-details-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-details-dialog")>()),
  ChannelDetailsDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Channel settings" /> : null,
}));

// jsdom does not implement the scrolling that cmdk uses for its active row.
const originalScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();

const optionRequests: string[] = [];
const optionAgents = [
  { id: "a1", name: "Marketing", agentType: "agent" },
  { id: "a2", name: "Support", agentType: "agent" },
];
const optionServer = setupServer(
  http.get("http://localhost:9000/api/agents/options", ({ request }) => {
    const url = new URL(request.url);
    optionRequests.push(url.pathname + url.search);
    const ids = [
      ...url.searchParams.getAll("ids"),
      ...url.searchParams.getAll("ids[]"),
    ].flatMap((value) => value.split(","));
    return HttpResponse.json(
      optionAgents.filter((agent) => ids.includes(agent.id)),
    );
  }),
  http.get("http://localhost:9000/api/agents/options/page", ({ request }) => {
    const url = new URL(request.url);
    optionRequests.push(url.pathname + url.search);
    const excluded = [
      ...url.searchParams.getAll("excludeIds"),
      ...url.searchParams.getAll("excludeIds[]"),
    ].flatMap((value) => value.split(","));
    const search = url.searchParams.get("search")?.toLowerCase() ?? "";
    return HttpResponse.json({
      data: optionAgents.filter(
        (agent) =>
          !excluded.includes(agent.id) &&
          agent.name.toLowerCase().includes(search),
      ),
      pagination: { hasNext: false, nextCursor: null },
    });
  }),
);
beforeAll(() => optionServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  optionServer.resetHandlers();
  optionRequests.length = 0;
});
afterAll(() => {
  optionServer.close();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  archestraApiClient.setConfig({ baseUrl: "" });
});
function QueryBoundary({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

function binding(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    provider: "ms-teams",
    channelId: `19:${id}`,
    channelName: id,
    workspaceId: "T1",
    workspaceName: "Engineering",
    isDm: false,
    answerAllMessages: false,
    channelInstructions: null,
    dmOwnerEmail: null,
    agentId: "a1",
    ...extra,
  };
}

function setup(
  bindings: Record<string, unknown>[],
  workspacesWithUnmentionedTraffic: string[] = [],
) {
  vi.mocked(useAllChatOpsBindings).mockReturnValue({
    data: {
      bindings,
      pages: [{ workspacesWithUnmentionedTraffic }],
    },
    isPending: false,
  } as unknown as ReturnType<typeof useAllChatOpsBindings>);
  render(<ProviderChannels provider="ms-teams" />, { wrapper: QueryBoundary });
}

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);

  vi.mocked(useUpdateChatOpsBinding).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateChatOpsBinding>);
});

describe("ProviderChannels", () => {
  it("lists the provider's channels with how each one replies", () => {
    setup([
      binding("general", { answerAllMessages: true, channelInstructions: "x" }),
      binding("escalations"),
      binding("deals", { provider: "slack" }),
    ]);

    expect(screen.getByRole("cell", { name: /general/ })).toBeVisible();
    expect(screen.getByRole("cell", { name: /escalations/ })).toBeVisible();
    expect(screen.queryByRole("cell", { name: /deals/ })).toBeNull();
    expect(screen.getByRole("cell", { name: "All messages" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "When @mentioned" })).toBeVisible();
  });

  it("keeps personal chats out until asked for", async () => {
    setup([
      binding("general"),
      binding("dm1", { isDm: true, dmOwnerEmail: "pat@example.com" }),
    ]);

    expect(screen.queryByText(/pat@example.com/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 personal chat" }),
    );
    expect(screen.getByText(/pat@example.com/)).toBeVisible();
  });

  it("searches channels by name", async () => {
    setup([binding("general"), binding("escalations")]);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Search channels" }),
      "escal",
    );

    expect(screen.getByRole("cell", { name: /escalations/ })).toBeVisible();
    expect(screen.queryByRole("cell", { name: /general/ })).toBeNull();
  });

  it("warns when replying to all may not work yet in a team", () => {
    setup(
      [
        binding("general", { answerAllMessages: true }),
        binding("support", { answerAllMessages: true, workspaceId: "T2" }),
      ],
      ["T2"],
    );

    expect(
      screen.getAllByText(/A team owner may need to allow the bot/),
    ).toHaveLength(1);
  });

  it("opens a channel's settings", async () => {
    setup([binding("general")]);

    await userEvent.click(
      screen.getByRole("button", { name: "Settings for general" }),
    );

    expect(
      screen.getByRole("dialog", { name: "Channel settings" }),
    ).toBeVisible();
  });

  it("hydrates assigned agents by ID and searches bounded remote options only when opened", async () => {
    setup([binding("general")]);
    await waitFor(() => expect(optionRequests.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").map((e) => e.textContent)).toEqual(
        ["All agents", "Marketing"],
      ),
    );
    expect(optionRequests.some((path) => path.includes("/page"))).toBe(false);
    const filter = screen
      .getAllByRole("combobox")
      .find((element) => element.textContent === "All agents");
    if (!filter) throw new Error("The agent filter is not visible");
    await userEvent.click(filter);
    expect(
      await screen.findByRole("option", { name: "Support" }),
    ).toBeVisible();
    await userEvent.type(
      screen.getByPlaceholderText("Search agents..."),
      "Support",
    );
    await waitFor(() =>
      expect(
        optionRequests.some((path) => path.includes("search=Support")),
      ).toBe(true),
    );
    const pages = optionRequests.filter((path) => path.includes("/page"));
    expect(
      pages.every(
        (path) =>
          new URL(path, "http://localhost:9000").searchParams.get("limit") ===
          "20",
      ),
    ).toBe(true);
    expect(
      optionRequests
        .filter((path) => !path.includes("/page"))
        .every((path) =>
          new URL(path, "http://localhost:9000").searchParams
            .keys()
            .some((key) => key.startsWith("ids")),
        ),
    ).toBe(true);
  });

  it("says how to get a first channel", () => {
    setup([]);

    expect(screen.getByText(/No MS Teams channels yet/)).toBeVisible();
  });
});
