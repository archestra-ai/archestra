import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
import { useOrganization } from "@/lib/organization.query";
import { SlackSetupDialog } from "./slack-setup-dialog";

vi.mock("sonner");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");

const API_ORIGIN = "http://localhost:9000";
const server = setupServer(
  http.get(`${API_ORIGIN}/api/chatops/status`, () =>
    HttpResponse.json({ providers: [] }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(usePublicBaseUrl).mockReturnValue("https://app.example.com");
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useOrganization>);
  class MockObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockObserver);
  vi.stubGlobal("IntersectionObserver", MockObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderSetup(
  connectionMode: "socket" | "webhook",
  agent?: { id: string; name: string },
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SlackSetupDialog
        open
        onOpenChange={vi.fn()}
        connectionMode={connectionMode}
        agent={agent}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("dialog");
}

function readManifest(dialog: HTMLElement) {
  return JSON.parse(dialog.querySelector("pre")?.textContent ?? "");
}

describe.each([
  "socket",
  "webhook",
] as const)("Slack %s command notice", (mode) => {
  it("shows the concise notice only for shortened names, without a command preview", () => {
    const dialog = renderSetup(mode);
    const input = within(dialog).getByLabelText("App Name", { exact: true });
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();

    for (const name of [
      "Archestra Engineering",
      "abcdefghijklmnopq remainder",
      "a".repeat(19),
    ]) {
      fireEvent.change(input, { target: { value: name } });
      const manifest = readManifest(dialog);
      const notice = within(dialog).getByRole("status");
      expect(notice).toHaveTextContent(
        "Slack commands are automatically shortened to fit Slack’s 32-character limit.",
      );
      expect(notice).not.toHaveTextContent(
        manifest.features.slash_commands[0].command,
      );
      expect(manifest.display_information.name).toBe(name);
      expect(
        manifest.features.slash_commands.every(
          (item: { command: string }) => item.command.length <= 32,
        ),
      ).toBe(true);
      expect(
        within(dialog).getByRole("button", { name: "Next" }),
      ).toBeEnabled();
    }

    for (const name of ["Archestra Staging", "a".repeat(18), "!!!", ""]) {
      fireEvent.change(input, { target: { value: name } });
      expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
      expect(readManifest(dialog).features.slash_commands).toHaveLength(3);
    }
  });

  it("does not announce shortened commands for an agent bot without slash commands", () => {
    const dialog = renderSetup(mode, { id: "test-agent", name: "Engineering" });
    fireEvent.change(
      within(dialog).getByLabelText("App Name", { exact: true }),
      {
        target: { value: "Archestra Engineering" },
      },
    );
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(readManifest(dialog).features.slash_commands).toBeUndefined();
  });
});
