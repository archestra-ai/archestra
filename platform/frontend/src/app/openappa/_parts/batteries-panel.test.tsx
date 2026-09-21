import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { BatteriesPanel } from "./batteries-panel";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
// Radix Select uses scrollIntoView and pointer capture, which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);

type Battery = archestraApiTypes.GetOpenappaBatteriesResponses["200"][number];
type Install = Battery["installs"][number];

const baseUrl = "http://localhost:9000";
const catalogId = "5b6d2f1e-3c4a-4d5e-8f6a-7b8c9d0e1f2a";
const server = setupServer();
let batteries: Battery[];
const github = (installs: Install[]): Battery => ({
  name: "github",
  description: "GitHub rules",
  source: "bundled",
  namespaces: ["github"],
  helpers: ["github_read_repo"],
  credentials: ["APPA_PROVIDER_GITHUB_TOKEN"],
  setup: null,
  installs,
});
const install = (fields: Partial<Install>): Install => ({
  id: "install-1",
  organizationId: "org",
  catalogId,
  batteryName: "github",
  enabled: true,
  credentialBindings: {},
  createdAt: "2026-09-18T12:00:00Z",
  updatedAt: "2026-09-18T12:00:00Z",
  status: "missing_credentials",
  ...fields,
});
const credential = {
  id: "cred-1",
  kind: "secret" as const,
  githubUrl: null,
  appId: null,
  installationId: null,
  githubClientId: null,
  githubAppCredentialKey: null,
  key: "github-token",
  name: "GitHub token",
  description: "",
  icon: null,
  builtIn: false,
  allowPersonal: false,
  allowOrganization: true,
  personalConfigured: false,
  organizationConfigured: true,
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  batteries = [github([])];
  server.use(
    http.get(`${baseUrl}/api/openappa/batteries`, () =>
      HttpResponse.json(batteries),
    ),
    http.get(`${baseUrl}/api/internal_mcp_catalog`, () =>
      HttpResponse.json([{ id: catalogId, name: "Code" }]),
    ),
    http.get(`${baseUrl}/api/credentials`, () =>
      HttpResponse.json([credential]),
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BatteriesPanel />
    </QueryClientProvider>,
  );
}

test("an install shows its server, and the switch turns the battery off through its install", async () => {
  batteries = [github([install({})])];
  server.use(
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-1`,
      async ({ request }) => {
        expect(await request.json()).toEqual({ enabled: false });
        const updated = install({ enabled: false, status: "disabled" });
        batteries = [github([updated])];
        return HttpResponse.json(updated);
      },
    ),
  );
  show();
  const item = await screen.findByRole("listitem");
  expect(item).toHaveTextContent("Code");
  const toggle = screen.getByRole("switch", { name: /github/ });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: /github/ })).not.toBeChecked(),
  );
});

test("binding an organization credential updates the install's bindings", async () => {
  batteries = [github([install({})])];
  server.use(
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-1`,
      async ({ request }) => {
        expect(await request.json()).toEqual({
          credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github-token" },
        });
        const updated = install({
          credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github-token" },
          status: "active",
        });
        batteries = [github([updated])];
        return HttpResponse.json(updated);
      },
    ),
  );
  show();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  );
  await user.click(screen.getByRole("option", { name: "GitHub token" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
    ).toHaveTextContent("GitHub token"),
  );
});

test("removing an install deletes it and drops it from the list", async () => {
  batteries = [github([install({})])];
  server.use(
    http.delete(`${baseUrl}/api/openappa/battery-installs/install-1`, () => {
      batteries = [github([])];
      return HttpResponse.json({ success: true });
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /remove the github battery/i }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument(),
  );
});

test("uploading a package sends the picked files by their path inside the folder", async () => {
  server.use(
    http.put(
      `${baseUrl}/api/openappa/battery-packages/acme`,
      async ({ request }) => {
        expect(await request.json()).toEqual({
          files: [{ path: "battery.toml", text: "schema = 1" }],
        });
        const uploaded: Battery = {
          ...github([]),
          name: "acme",
          description: "Acme rules",
          source: "organization",
          credentials: [],
        };
        batteries = [github([]), uploaded];
        return HttpResponse.json(uploaded);
      },
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /upload package/i }),
  );
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "acme" },
  });
  const file = new File(["schema = 1"], "battery.toml", {
    type: "application/toml",
  });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "acme/battery.toml",
  });
  fireEvent.change(screen.getByLabelText("Package folder"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  expect(
    await screen.findByRole("button", { name: /delete the acme package/i }),
  ).toBeVisible();
});

test("without the permission to manage guardrails the controls are read-only", async () => {
  batteries = [github([install({})])];
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(await screen.findByRole("switch", { name: /github/ })).toBeDisabled();
  expect(
    screen.getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /upload package/i }),
  ).not.toBeInTheDocument();
});
