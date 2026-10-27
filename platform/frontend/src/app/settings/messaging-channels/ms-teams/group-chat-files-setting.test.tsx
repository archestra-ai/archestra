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
import { useAppName } from "@/lib/hooks/use-app-name";
import { GroupChatFilesSetting } from "./group-chat-files-setting";

vi.mock("sonner");
vi.mock("@/lib/hooks/use-app-name");

const API_ORIGIN = "http://localhost:9000";
const APP_ID = "50a1c2d3-0000-4000-8000-000000000000";
const REDIRECT_URI =
  "https://archestra.example.com/api/webhooks/chatops/ms-teams/sign-in/callback";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("GroupChatFilesSetting", () => {
  it("saves the switch as soon as it flips", async () => {
    const putBodies = serveConfig();
    const user = userEvent.setup();
    renderSetting();

    const toggle = await screen.findByRole("switch", {
      name: /group-chat files/i,
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);

    await waitFor(() =>
      expect(putBodies).toEqual([{ groupChatFileSignIn: true }]),
    );
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
  });

  it("copies an IT request with the app, redirect URI, and permissions", async () => {
    serveConfig();
    const user = userEvent.setup();
    renderSetting();

    await user.click(
      await screen.findByRole("button", { name: /microsoft entra setup/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /copy request for it/i }),
    );

    const request = await navigator.clipboard.readText();
    expect(request).toContain(APP_ID);
    expect(request).toContain(REDIRECT_URI);
    expect(request).toContain("Files.Read and offline_access");
    expect(
      await screen.findByRole("button", { name: /copied/i }),
    ).toBeInTheDocument();
  });
});

function renderSetting() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GroupChatFilesSetting />
    </QueryClientProvider>,
  );
}

/** Serve a stored config whose switch follows each save; returns the saved bodies. */
function serveConfig(): unknown[] {
  let saved = false;
  const putBodies: unknown[] = [];
  server.use(
    http.get(`${API_ORIGIN}/api/chatops/status`, () =>
      HttpResponse.json({ providers: [] }),
    ),
    http.get(`${API_ORIGIN}/api/chatops/config/ms-teams`, () =>
      HttpResponse.json({
        configured: true,
        updatedAt: "2026-10-21T00:00:00.000Z",
        enabled: true,
        appId: APP_ID,
        tenantId: "tenant-id",
        groupChatFileSignIn: saved,
        signInRedirectUri: REDIRECT_URI,
      }),
    ),
    http.put(
      `${API_ORIGIN}/api/chatops/config/ms-teams`,
      async ({ request }) => {
        const body = (await request.json()) as {
          groupChatFileSignIn?: boolean;
        };
        putBodies.push(body);
        saved = body.groupChatFileSignIn ?? saved;
        return HttpResponse.json({ success: true });
      },
    ),
  );
  return putBodies;
}
