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
import { usePublicBaseUrl } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { MsTeamsSetupDialog } from "./ms-teams-setup-dialog";

vi.mock("sonner");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query");

// embla-carousel needs these as constructors in jsdom.
class MockObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockObserver as unknown as typeof ResizeObserver;
global.IntersectionObserver =
  MockObserver as unknown as typeof IntersectionObserver;
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

const API_ORIGIN = "http://localhost:9000";
const REDIRECT_URI =
  "https://archestra.example.com/api/webhooks/chatops/ms-teams/sign-in/callback";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(usePublicBaseUrl).mockReturnValue("https://archestra.example.com");
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("MsTeamsSetupDialog group-chat files", () => {
  it("reopens on the saved setting, with the redirect URI to register", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/chatops/status`, () =>
        HttpResponse.json({ providers: [] }),
      ),
      http.get(`${API_ORIGIN}/api/chatops/config/ms-teams`, () =>
        HttpResponse.json({
          configured: true,
          updatedAt: "2026-10-21T00:00:00.000Z",
          enabled: true,
          appId: "app-id",
          tenantId: "tenant-id",
          groupChatFileSignIn: true,
          signInRedirectUri: REDIRECT_URI,
        }),
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MsTeamsSetupDialog open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await userEvent.click(
      await screen.findByRole("tab", { name: /group chats/i }),
    );
    const toggle = await screen.findByRole("switch", {
      name: /sign in for group-chat files/i,
    });
    // The config arrives after the first render; the switch must follow it.
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText(REDIRECT_URI)).toBeInTheDocument();
  });
});
