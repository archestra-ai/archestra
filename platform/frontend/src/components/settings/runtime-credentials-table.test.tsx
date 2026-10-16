import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { AccountPageActionSlotContext } from "@/app/account/_components/account-page-action";
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import type { RuntimeCredentialDefinition } from "@/lib/runtime-credentials.query";
import { RuntimeCredentialsSection } from "./runtime-credentials-section";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/components/claude-code-account", () => ({
  ClaudeCodeAccount: () => <div>Claude Code sign-in</div>,
}));
vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => null,
}));
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
    gitlabUrl: null,
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

/**
 * The page's query string, which the router mock writes and `useSearchParams`
 * reads back, so a search or filter survives the navigation it causes.
 */
let url = new URLSearchParams();
const urlListeners = new Set<() => void>();
const navigate = (href: string) => {
  url = new URLSearchParams(href.split("?")[1] ?? "");
  for (const listener of urlListeners) listener();
};
const useUrl = () =>
  useSyncExternalStore(
    (listener) => {
      urlListeners.add(listener);
      return () => urlListeners.delete(listener);
    },
    () => url,
  );
const mockUrlNavigation = () => {
  url = new URLSearchParams();
  vi.mocked(usePathname).mockReturnValue("/settings/credentials");
  vi.mocked(useRouter).mockReturnValue({
    replace: vi.fn(navigate),
    push: vi.fn(navigate),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockImplementation(
    () => useUrl() as ReturnType<typeof useSearchParams>,
  );
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => server.resetHandlers());
beforeEach(() => {
  mockUrlNavigation();
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useFeature).mockReturnValue(false as never);

  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useScopedCapabilities>);
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
  await user.click(screen.getByRole("option", { name: "GitHub App" }));
  expect(screen.getByText("Credential 11")).toBeVisible();
  expect(screen.queryByText("Credential 0")).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Filter by scope" }));
  await user.click(
    screen.getByRole("option", { name: "Each user (personal)" }),
  );
  expect(screen.getByText("No credentials match your filters")).toBeVisible();
  await user.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: "Clear filters",
    }),
  );
  expect(screen.getByText("Credential 0")).toBeVisible();
});

it("Personal Settings lists your personal credentials and never other people's", async () => {
  const user = userEvent.setup();
  const requested: (string | null)[] = [];
  server.use(
    http.get(`${origin}/api/credentials`, ({ request }) => {
      requested.push(new URL(request.url).searchParams.get("access"));
      return HttpResponse.json(credentials);
    }),
  );
  // Bookmarked from Settings, where this reader may browse every credential.
  url = new URLSearchParams("access=others");
  renderTable("personal");
  await screen.findByText("Credential 0");
  expect(requested.at(-1)).not.toContain("others");

  // The organization's GitHub App stays in Settings.
  await user.type(
    screen.getByPlaceholderText(
      "Search credentials by name, key, and description",
    ),
    "credential-11",
  );
  expect(
    await screen.findByText("No credentials match your filters"),
  ).toBeVisible();
  expect(
    screen.queryByRole("columnheader", { name: "Provided by" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Filter by scope" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Filter by type" }));
  expect(
    screen.queryByRole("option", { name: "GitHub App" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Filter by access" }));
  expect(screen.getByText("Shared with me")).toBeVisible();
  expect(screen.queryByText("Admin access")).not.toBeInTheDocument();
});

it("adds a credential only you can use, then asks for its value", async () => {
  const user = userEvent.setup();
  let created: RuntimeCredentialDefinition | null = null;
  let body: Record<string, unknown> = {};
  server.use(
    http.get(`${origin}/api/credentials`, () =>
      HttpResponse.json(created ? [...credentials, created] : credentials),
    ),
    http.post(`${origin}/api/credentials`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      created = {
        ...credentials[0],
        id: "definition-new",
        key: String(body.key),
        name: String(body.name),
      };
      return HttpResponse.json(created);
    }),
  );
  renderTable("personal");
  await screen.findByText("Credential 0");
  await user.click(screen.getByRole("button", { name: "Add credential" }));
  const dialog = await screen.findByRole("dialog");
  // Nobody else gets it, so there is nothing to choose about who provides
  // or shares it.
  expect(within(dialog).queryByText("Provided by")).not.toBeInTheDocument();
  await user.type(within(dialog).getByLabelText("Name"), "My token");
  await user.click(within(dialog).getByRole("button", { name: "Add" }));

  expect(
    await screen.findByRole("dialog", { name: /Connect My token/ }),
  ).toBeVisible();
  expect(body).toMatchObject({
    name: "My token",
    allowPersonal: true,
    allowOrganization: false,
    initialGrants: [],
  });
});

it("Settings → Credentials shows the reader's Claude Code sign-in above the table", async () => {
  vi.mocked(useFeature).mockImplementation(
    (feature) => (feature === "agentRuntime") as never,
  );
  server.use(
    http.get(`${origin}/api/agents/options/page`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      expect(query.get("runtimeCommand")).toBe("archestra-claude-code");
      expect(query.get("limit")).toBe("1");
      return HttpResponse.json({
        data: [
          { id: "agent-1", runtime: { command: ["archestra-claude-code"] } },
        ],
        pagination: { limit: 1, nextCursor: null, hasNext: false },
      });
    }),
  );
  renderTable();
  await screen.findByText("Credential 0");
  expect(await screen.findByText("Claude Code sign-in")).toBeVisible();
});

it("Settings Add credential adds one just for you when you cannot create shared ones", async () => {
  const user = userEvent.setup();
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: !(
          "credential" in permissions &&
          permissions.credential?.includes("create")
        ),
      }) as ReturnType<typeof useHasPermissions>,
  );
  let body: Record<string, unknown> = {};
  server.use(
    http.post(`${origin}/api/credentials`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...credentials[0], id: "definition-new" });
    }),
  );
  renderTable();
  await screen.findByText("Credential 0");
  // Settings puts its header action in the layout through setActionButton.
  const header = setActionButton.mock.calls.findLast(([node]) => node)?.[0];
  render(header);
  const add = screen.getByRole("button", { name: "Add credential" });
  expect(add).toBeEnabled();
  await user.click(add);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByText("Provided by")).not.toBeInTheDocument();
  await user.type(within(dialog).getByLabelText("Name"), "My token");
  await user.click(within(dialog).getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(body).toMatchObject({
      allowPersonal: true,
      allowOrganization: false,
      initialGrants: [],
    }),
  );
});

function renderTable(mode?: "organization" | "personal") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["secrets", "type"], { type: "database" });
  const slot = document.createElement("div");
  document.body.append(slot);
  render(
    <QueryClientProvider client={client}>
      <AccountPageActionSlotContext.Provider value={slot}>
        <RuntimeCredentialsSection mode={mode} />
      </AccountPageActionSlotContext.Provider>
    </QueryClientProvider>,
  );
}
