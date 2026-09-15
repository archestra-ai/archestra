import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter } from "next/navigation";
import { StrictMode } from "react";
import { rememberGitHubConnectionReturn } from "@/lib/github-connection-return";
import GitHubConnectionCallback from "./page";

vi.mock("next/navigation");
vi.mock("sonner");
const server = setupServer();
const replace = vi.fn();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  vi.mocked(useRouter).mockReturnValue({ replace } as unknown as ReturnType<
    typeof useRouter
  >);
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  window.history.replaceState(
    null,
    "",
    "/github/callback?code=synthetic-code&state=synthetic-state",
  );
});
function renderCallback() {
  return render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <GitHubConnectionCallback />
      </QueryClientProvider>
    </StrictMode>,
  );
}
it.each([
  "/account/connections",
  "/settings/credentials",
  "/agents/agent-1?section=advanced&setup=credentials#runtime-credentials",
])("completes once in strict mode and returns to %s without leaving authorization in the URL", async (destination) => {
  rememberGitHubConnectionReturn("synthetic-state", destination);
  let calls = 0;
  server.use(
    http.post(
      "http://localhost:9000/api/credentials/github/callback",
      async ({ request }) => {
        calls++;
        expect(await request.json()).toEqual({
          code: "synthetic-code",
          state: "synthetic-state",
        });
        return HttpResponse.json({
          id: "github",
          login: "example-developer",
          configured: true,
        });
      },
    ),
  );
  renderCallback();
  await waitFor(() => expect(replace).toHaveBeenCalledWith(destination));
  expect(calls).toBe(1);
  expect(window.location.search).toBe("");
});
it.each([
  "/account/connections",
  "/settings/credentials",
  "/agents/agent-1?section=advanced&setup=credentials#runtime-credentials",
])("returns to %s to recover from expired authorization", async (destination) => {
  rememberGitHubConnectionReturn("synthetic-state", destination);
  server.use(
    http.post("http://localhost:9000/api/credentials/github/callback", () =>
      HttpResponse.json(
        { error: { message: "Sign-in expired", type: "api_error" } },
        { status: 400 },
      ),
    ),
  );
  renderCallback();
  expect(
    await screen.findByRole("heading", { name: "Let’s reconnect GitHub" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Saving GitHub connection" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: destination.startsWith("/agents/")
        ? "Back to your agent"
        : destination === "/settings/credentials"
          ? "Back to credentials"
          : "Back to connections",
    }),
  );
  expect(replace).toHaveBeenCalledWith(destination);
});
it("offers a fresh sign-in when opened without authorization parameters", async () => {
  window.history.replaceState(null, "", "/github/callback");
  renderCallback();
  expect(
    await screen.findByRole("button", { name: "Back to connections" }),
  ).toBeInTheDocument();
});

it("returns a declined authorization to the originating Agent without exchanging a code", async () => {
  const destination = "/agents/agent-1?section=advanced&setup=credentials";
  rememberGitHubConnectionReturn("synthetic-state", destination);
  window.history.replaceState(
    null,
    "",
    "/github/callback?error=access_denied&state=synthetic-state",
  );
  let calls = 0;
  server.use(
    http.post("http://localhost:9000/api/credentials/github/callback", () => {
      calls++;
      return HttpResponse.json({});
    }),
  );
  renderCallback();
  fireEvent.click(
    await screen.findByRole("button", { name: "Back to your agent" }),
  );
  expect(replace).toHaveBeenCalledWith(destination);
  expect(calls).toBe(0);
  expect(window.location.search).toBe("");
});
