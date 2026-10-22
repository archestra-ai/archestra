import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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
import { AgentRuntimeUnavailableNotice } from "./agent-runtime-unavailable-notice";

vi.mock("@/lib/auth/auth.query");

const API_ORIGIN = "http://localhost:9000";
const inspectCluster = vi.fn();
const server = setupServer(
  http.get(`${API_ORIGIN}/api/k8s/capabilities`, () => {
    inspectCluster();
    return HttpResponse.json({
      agentSandbox: {
        installed: false,
        missingResources: ["sandboxclaims.extensions.agents.x-k8s.io"],
        message: "The Agent Sandbox controller is not installed.",
      },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  inspectCluster.mockClear();
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderNotice() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentRuntimeUnavailableNotice />
    </QueryClientProvider>,
  );
}

describe("Agent Runtime unavailable notice", () => {
  it("reveals the discovered missing API resources only when requested", async () => {
    renderNotice();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Agent Runtime unavailable. The Agent Sandbox controller is not installed.",
    );
    const toggle = await screen.findByRole("button", { name: "Show details" });
    expect(screen.queryByText(/Missing API resources/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(/Missing API resources/)).toHaveTextContent(
      "sandboxclaims.extensions.agents.x-k8s.io",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByText(/Missing API resources/)).not.toBeInTheDocument();
  });

  it("does not inspect the cluster or expose diagnostics to members", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    renderNotice();
    expect(screen.getByRole("alert")).toHaveTextContent("Ask an administrator");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(inspectCluster).not.toHaveBeenCalled();
  });

  it("shows the inspection failure without inventing missing resources", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/k8s/capabilities`, () =>
        HttpResponse.json({
          agentSandbox: {
            installed: false,
            missingResources: [],
            message: "Kubernetes capabilities could not be inspected.",
          },
        }),
      ),
    );
    renderNotice();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show details" }),
    );
    expect(
      screen.getByText("Kubernetes capabilities could not be inspected."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Missing API resources/)).not.toBeInTheDocument();
  });
});
