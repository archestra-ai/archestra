import {
  archestraApiClient,
  type archestraApiTypes,
  E2eTestId,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { hasPermissions } from "@/lib/auth/auth.utils";
import { ClaudeCodeSubscriptionCard } from "./claude-code-subscription-card";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

const origin = "http://localhost:9000";
const accountUrl = `${origin}/api/agent-runtime/claude-code/account`;
const server = setupServer();
let queryClient: QueryClient;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  archestraApiClient.setConfig({ baseUrl: origin });
  // Stand in for a regular member with no admin API-key permissions: connecting,
  // managing, and disconnecting one's own Claude Code subscription are all self-service.
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: hasPermissions({}, permissions),
      }) as ReturnType<typeof useHasPermissions>,
  );
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  queryClient.clear();
  vi.clearAllMocks();
});

describe("ClaudeCodeSubscriptionCard", () => {
  it("connects, manages, and disconnects the viewer's Claude Code subscription", async () => {
    const user = userEvent.setup();
    let account: archestraApiTypes.GetMyClaudeCodeAccountResponses["200"] = {
      state: "disconnected",
    };
    server.use(
      http.get(accountUrl, () => HttpResponse.json(account)),
      http.post(accountUrl, () => {
        account = {
          state: "awaiting_code",
          flowId: "00000000-0000-4000-8000-000000000001",
          authorizationUrl: "https://claude.ai/oauth/authorize",
        };
        return HttpResponse.json(account);
      }),
      http.post(`${accountUrl}/complete`, () => {
        account = {
          state: "connected",
          expiresAt: "2027-06-15T00:00:00.000Z",
        };
        return HttpResponse.json(account);
      }),
      http.delete(accountUrl, () => {
        account = { state: "disconnected" };
        return HttpResponse.json(account);
      }),
    );

    renderCard(true);

    const card = screen.getByTestId(
      `${E2eTestId.SubscriptionProviderCard}-claude-code`,
    );
    expect(within(card).getByText("Claude Code")).toBeVisible();
    expect(await within(card).findByText("Not connected")).toBeVisible();

    await user.click(within(card).getByRole("button", { name: "Connect" }));
    const signInDialog = screen.getByRole("dialog", {
      name: "Connect Claude Code",
    });
    expect(
      await within(signInDialog).findByRole("link", { name: "Open Claude" }),
    ).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
    await user.type(
      within(signInDialog).getByLabelText("Authorization code"),
      "example-code#state",
    );
    await user.click(
      within(signInDialog).getByRole("button", { name: "Complete sign-in" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(await within(card).findByText("Connected")).toBeVisible();
    expect(
      within(card).getByText(
        "Connect your Claude account to use your subscription.",
      ),
    ).toBeVisible();

    // Manage opens the status dialog with expiry and Disconnect.
    await user.click(within(card).getByRole("button", { name: "Manage" }));
    const manageDialog = screen.getByRole("dialog", {
      name: "Claude Code account",
    });
    expect(within(manageDialog).getByText("Connected for you")).toBeVisible();
    expect(within(manageDialog).getByText(/Reconnect by/)).toBeVisible();
    await user.click(
      within(manageDialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    // Card Disconnect icon confirms before disconnecting.
    await user.click(within(card).getByRole("button", { name: "Disconnect" }));
    const confirmDialog = await screen.findByRole("dialog", {
      name: "Disconnect Claude Code",
    });
    await user.click(
      within(confirmDialog).getByRole("button", { name: "Disconnect" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(await within(card).findByText("Not connected")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Connect" })).toBeVisible();
  });

  it("shows Reconnect required when expired and starts sign-in from Reconnect", async () => {
    const user = userEvent.setup();
    let account: archestraApiTypes.GetMyClaudeCodeAccountResponses["200"] = {
      state: "expired",
    };
    server.use(
      http.get(accountUrl, () => HttpResponse.json(account)),
      http.post(accountUrl, () => {
        account = {
          state: "awaiting_code",
          flowId: "00000000-0000-4000-8000-000000000002",
          authorizationUrl: "https://claude.ai/oauth/authorize?retry=1",
        };
        return HttpResponse.json(account);
      }),
    );

    renderCard(true);

    expect(await screen.findByText("Reconnect required")).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(
      await screen.findByRole("link", { name: "Open Claude" }),
    ).toHaveAttribute("href", "https://claude.ai/oauth/authorize?retry=1");
  });

  it("shows a retryable error state instead of Not connected when status check fails", async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get(accountUrl, () =>
        fail
          ? HttpResponse.json(
              { error: { message: "Unavailable" } },
              { status: 503 },
            )
          : HttpResponse.json({ state: "disconnected" }),
      ),
    );

    renderCard(true);

    expect(await screen.findByText("Could not check connection")).toBeVisible();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not connected")).toBeVisible();
  });

  it("hides an unconnected card when Anthropic is turned off, but keeps an existing connection disconnectable", async () => {
    let account: archestraApiTypes.GetMyClaudeCodeAccountResponses["200"] = {
      state: "disconnected",
    };
    server.use(http.get(accountUrl, () => HttpResponse.json(account)));

    const { rerender } = renderCard(false);
    await waitFor(() =>
      expect(
        screen.queryByTestId(
          `${E2eTestId.SubscriptionProviderCard}-claude-code`,
        ),
      ).not.toBeInTheDocument(),
    );

    account = { state: "connected" };
    await queryClient.invalidateQueries({ queryKey: ["claude-code-account"] });
    rerender(
      <QueryClientProvider client={queryClient}>
        <ClaudeCodeSubscriptionCard canAddAnthropic={false} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });
});

function renderCard(canAddAnthropic: boolean) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeSubscriptionCard canAddAnthropic={canAddAnthropic} />
    </QueryClientProvider>,
  );
}
