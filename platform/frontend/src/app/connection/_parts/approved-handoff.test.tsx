import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ApprovedHandoff } from "./approved-handoff";

const origin = "http://localhost:9000";
const server = setupServer(
  http.get(`${origin}/api/bootstrap`, () => HttpResponse.json({})),
);
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(cleanup);
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

// The preview must promise only the prompts the installer really asks: a
// client whose sign-in or start happens elsewhere gets no [Y/n] for it.
test.each([
  {
    clientId: "claude-code",
    label: "Claude Code",
    platform: "macos",
    authorizes: true,
    starts: true,
  },
  {
    clientId: "claude-code",
    label: "Claude Code",
    platform: "windows",
    authorizes: true,
    starts: false,
  },
  {
    clientId: "copilot-cli",
    label: "Copilot CLI",
    platform: "macos",
    authorizes: false,
    starts: true,
  },
  {
    clientId: "cursor",
    label: "Cursor",
    platform: "macos",
    authorizes: false,
    starts: false,
  },
])("$label on $platform shows only the prompts its installer asks", ({
  clientId,
  label,
  platform,
  authorizes,
  starts,
}) => {
  showHandoff({ clientId, label, platform });
  expect(
    screen.queryByText(/^Authorize now\? This opens Archestra/) !== null,
  ).toBe(authorizes);
  expect(screen.queryByText(`Start ${label} now? [Y/n]`) !== null).toBe(starts);
});

test("Claude Desktop asks nothing in the terminal and says it restarts itself", () => {
  showHandoff({
    clientId: "claude-desktop",
    label: "Claude Desktop",
    platform: "macos",
  });
  expect(
    screen.getByRole("heading", { name: "Finish in the setup terminal" }),
  ).toBeVisible();
  expect(screen.queryByText(/\[Y\/n\]/)).not.toBeInTheDocument();
});

test("the terminal names the gateway as the client lists it", () => {
  showHandoff({ clientId: "codex", label: "Codex", platform: "linux" });
  expect(
    screen.getByText('Authorize Codex for the "archestra" MCP gateway'),
  ).toBeVisible();
});

function showHandoff(params: {
  clientId: string;
  label: string;
  platform: string;
}) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ApprovedHandoff
        clientId={params.clientId}
        clientLabel={params.label}
        appName="Archestra"
        platform={params.platform}
        gateway={{ id: "gateway-1", name: "My Gateway" }}
        mcpServerName="archestra"
        proxySelected={false}
        skillsSelected={false}
        clientSteps={null}
      />
    </QueryClientProvider>,
  );
}
