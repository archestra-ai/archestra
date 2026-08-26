import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { useSession } from "@/lib/auth/auth.query";
import { ChannelsSection } from "./channels-section";
import type { ProviderConfig } from "./types";

const API_ORIGIN = "http://localhost:9000";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WITH_ID = "22222222-2222-4222-8222-222222222222";
const WITHOUT_ID = "33333333-3333-4333-8333-333333333333";
const INSTRUCTIONS =
  "Every message in this channel is a task — create it immediately.";

function binding(overrides: Record<string, unknown>) {
  return {
    id: WITH_ID,
    organizationId: "org-1",
    provider: "slack",
    channelId: "C1",
    workspaceId: "T1",
    channelName: "incident-response",
    workspaceName: "Workspace",
    isDm: false,
    answerAllMessages: false,
    channelInstructions: null,
    dmOwnerEmail: null,
    agentId: AGENT_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const providerConfig: ProviderConfig = {
  provider: "slack",
  providerLabel: "Slack",
  providerIcon: "/icons/slack.png",
  supportsAnswerAll: true,
  docsUrl: null,
  slashCommand: "/select-agent",
  buildDeepLink: () => null,
};

const server = setupServer();
/** Bodies of every PATCH the table sent, in order. */
let patched: Array<Record<string, unknown>>;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/messaging-channels/slack");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1", email: "admin@example.com" } },
  } as unknown as ReturnType<typeof useSession>);
  patched = [];
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  const bindings = [
    binding({ channelInstructions: INSTRUCTIONS }),
    binding({
      id: WITHOUT_ID,
      channelId: "C2",
      channelName: "random",
      channelInstructions: null,
    }),
  ];
  server.use(
    http.get(`${API_ORIGIN}/api/chatops/bindings`, () =>
      HttpResponse.json({
        data: bindings,
        pagination: { total: bindings.length, limit: 20, offset: 0 },
        counts: { configured: bindings.length, unassigned: 0 },
        workspaces: [{ id: "T1", name: "Workspace" }],
        hasDmBinding: true,
        workspacesWithUnmentionedTraffic: [],
      }),
    ),
    http.get(`${API_ORIGIN}/api/chatops/status`, () =>
      HttpResponse.json({
        providers: [{ id: "slack", displayName: "Slack", configured: true }],
      }),
    ),
    http.get(`${API_ORIGIN}/api/agents`, () =>
      HttpResponse.json([
        { id: AGENT_ID, name: "Support Bot", scope: "org", authorId: null },
      ]),
    ),
    http.patch(
      `${API_ORIGIN}/api/chatops/bindings/:id`,
      async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        patched.push(body);
        return HttpResponse.json(binding({ id: params.id as string, ...body }));
      },
    ),
  );
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderTable() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChannelsSection providerConfig={providerConfig} />
    </QueryClientProvider>,
  );
}

describe("channels table — per-channel instructions", () => {
  it("distinguishes a channel that has instructions from one that does not", async () => {
    renderTable();

    const configured = await screen.findByRole("row", {
      name: /incident-response/,
    });
    expect(
      await screen.findByRole("row", { name: /random/ }),
    ).toBeInTheDocument();

    // The label is the only cue in the table that a channel carries a policy.
    expect(screen.getByRole("row", { name: /random/ }).textContent).toContain(
      "Add",
    );
    expect(configured.textContent).toContain("Edit");
  });

  it("saves an edit as the channel's instructions", async () => {
    const user = userEvent.setup();
    renderTable();

    const row = await screen.findByRole("row", { name: /incident-response/ });
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    const textarea = await screen.findByLabelText("Channel instructions");
    // Seeded from what is stored, so an edit starts from the current policy
    // rather than a blank box that would silently replace it.
    expect(textarea).toHaveValue(INSTRUCTIONS);
    await user.clear(textarea);
    await user.type(textarea, "Reply with the deploy status only.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patched).toEqual([
        { channelInstructions: "Reply with the deploy status only." },
      ]),
    );
    expect(row).toBeInTheDocument();
  });

  it("clears the instructions when the editor is emptied", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.clear(await screen.findByLabelText("Channel instructions"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patched).toEqual([{ channelInstructions: null }]),
    );
  });

  it("refuses to save instructions past the length limit", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(await screen.findByRole("button", { name: "Add" }));
    const textarea = await screen.findByLabelText("Channel instructions");
    await user.click(textarea);
    await user.paste("x".repeat(4001));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(patched).toEqual([]);
  });
});
