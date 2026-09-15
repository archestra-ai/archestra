import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { RuntimeCredentialDefinition } from "@/lib/runtime-credentials.query";
import { RuntimeCredentialsSection } from "./runtime-credentials-section";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => setActionButton,
}));
const setActionButton = vi.fn();
const origin = "http://localhost:9000";
const server = setupServer();
const credentials: RuntimeCredentialDefinition[] = Array.from(
  { length: 12 },
  (_, index) => ({
    id: `definition-${index}`,
    githubUrl: null,
    appId: null,
    installationId: null,
    githubClientId: null,
    githubAppCredentialKey: null,
    key: `credential-${index}`,
    name: `Credential ${index}`,
    description: index === 11 ? "Release automation" : "Repository access",
    kind: index === 11 ? "github_app" : "secret",
    icon: null,
    builtIn: false,
    allowPersonal: index !== 11,
    allowOrganization: index === 11,
    personalConfigured: false,
    organizationConfigured: index === 11,
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => server.resetHandlers());
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  Element.prototype.scrollIntoView = vi.fn();
  server.use(
    http.get(`${origin}/api/secrets/type`, () =>
      HttpResponse.json({ type: "database" }),
    ),
    http.get(`${origin}/api/credentials`, () => HttpResponse.json(credentials)),
  );
});

it("paginates credentials and resets the page when searching across descriptions and keys", async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText("Credential 0");
  expect(screen.queryByText("Credential 11")).not.toBeInTheDocument();
  await user.click(
    screen.getAllByRole("button", { name: "Go to next page" })[0],
  );
  expect(screen.getByText("Credential 11")).toBeVisible();
  const search = screen.getByPlaceholderText(
    "Search credentials by name, key, and description",
  );
  await user.type(search, " REPOSITORY ");
  await waitFor(() => expect(screen.getByText("Credential 0")).toBeVisible());
  expect(screen.queryByText("Credential 11")).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "credential-11");
  await waitFor(() =>
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      2,
    ),
  );
  expect(screen.getByText("Credential 11")).toBeVisible();
});

it("combines type and ownership filters and clears an empty result", async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText("Credential 0");
  await user.click(screen.getByRole("combobox", { name: "Filter by type" }));
  await user.click(screen.getByRole("button", { name: "GitHub App" }));
  expect(screen.getByText("Credential 11")).toBeVisible();
  expect(screen.queryByText("Credential 0")).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Filter by scope" }));
  await user.click(
    screen.getByRole("button", { name: "Each user (personal)" }),
  );
  expect(screen.getByText("No credentials match your filters")).toBeVisible();
  await user.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: "Clear filters",
    }),
  );
  expect(screen.getByText("Credential 0")).toBeVisible();
});

function renderTable() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["secrets", "type"], { type: "database" });
  render(
    <QueryClientProvider client={client}>
      <RuntimeCredentialsSection />
    </QueryClientProvider>,
  );
}
