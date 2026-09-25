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
  expect,
  test,
  vi,
} from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { OverviewTab } from "./overview-tab";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("./coverage-charts", () => ({
  CoverageCharts: () => <div>Coverage charts</div>,
}));
vi.mock("./entities-table", () => ({
  EntitiesTable: () => <div>Entities table</div>,
}));
vi.mock("./overview-setup-cards", async (importActual) => ({
  ...(await importActual<typeof import("./overview-setup-cards")>()),
  OverviewSetupCards: () => null,
}));

const api = "http://localhost:9000/api";
const server = setupServer();
let enabled: boolean;
let revision: number;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  localStorage.clear();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useSession).mockReturnValue({
    data: { session: { activeOrganizationId: "org" }, user: { id: "user" } },
  } as ReturnType<typeof useSession>);
  enabled = false;
  revision = 0;
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json({ enabled, featureEnabled: true, active: enabled }),
    ),
    http.get(`${api}/guardrails-policy`, () =>
      HttpResponse.json({
        organizationId: "org",
        revision,
        content: "",
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OverviewTab />
    </QueryClientProvider>,
  );
}

test("a fresh instance hides coverage and welcomes the user once", async () => {
  const view = show();
  const dialog = await screen.findByRole("dialog", {
    name: "Guardrails for your tool calls",
  });
  expect(
    within(dialog).getByRole("link", { name: "Set up with chat" }),
  ).toHaveAttribute(
    "href",
    expect.stringMatching(
      /^\/chat\?openappa=1&openappaPrompt=setUpPolicy&from=openappa$/,
    ),
  );
  expect(
    screen.getByText("Coverage appears once the guardrail is on"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Coverage charts")).not.toBeInTheDocument();
  expect(screen.queryByText("Entities table")).not.toBeInTheDocument();

  view.unmount();
  show();
  expect(
    await screen.findByText("Coverage appears once the guardrail is on"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "How it works" }));
  expect(
    await screen.findByRole("dialog", {
      name: "Guardrails for your tool calls",
    }),
  ).toBeInTheDocument();
});

test.each([
  ["enforcement is on", true, 0],
  ["a policy is saved", false, 2],
])("shows coverage without a welcome when %s", async (_, on, saved) => {
  enabled = on;
  revision = saved;
  show();
  expect(await screen.findByText("Coverage charts")).toBeInTheDocument();
  expect(screen.getByText("Entities table")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
