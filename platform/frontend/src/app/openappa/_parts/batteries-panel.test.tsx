import type { Permissions } from "@archestra/shared";
import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  test,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { BatteriesPanel, BatteriesUploadAction } from "./batteries-panel";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
vi.mock("sonner");
// Radix Select uses scrollIntoView and pointer capture, which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);

type Battery = archestraApiTypes.GetOpenappaBatteriesResponses["200"][number];
type Install = Battery["installs"][number];
type Declarations =
  archestraApiTypes.GetOpenappaPolicyDeclarationsResponses["200"];
type PolicyBattery = Declarations["batteries"][number];

const baseUrl = "http://localhost:9000";
const catalogId = "5b6d2f1e-3c4a-4d5e-8f6a-7b8c9d0e1f2a";
const otherCatalogId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const freshCatalogId = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const bareCatalogId = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
const freshServerId = "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a9f";
const uploadHash = "a".repeat(64);
const server = setupServer();
let batteries: Battery[];
let declarations: Declarations;
/** Whether the Fresh server's tools have been synced since the render. */
let freshSynced: boolean;

const install = (fields: Partial<Install> = {}): Install => ({
  id: "install-1",
  organizationId: "org",
  catalogId,
  batteryName: "github",
  enabled: true,
  packageHash: null,
  lastError: null,
  credentialBindings: {},
  createdAt: "2026-09-18T12:00:00Z",
  updatedAt: "2026-09-18T12:00:00Z",
  status: "missing_credentials",
  ...fields,
});
const githubBattery = (installs: Install[] = []): Battery => ({
  name: "github",
  description: "GitHub rules",
  source: "bundled",
  contentHash: null,
  namespaces: ["github"],
  annotators: [],
  scope: "catalogs",
  helpers: ["github_read_repo"],
  credentials: ["APPA_PROVIDER_GITHUB_TOKEN"],
  setup: null,
  installs,
});
const declaredGithub = (
  fields: Partial<PolicyBattery> = {},
): PolicyBattery => ({
  entry: "github",
  name: "github",
  source: "bundled",
  packageHash: null,
  status: "missing_credentials",
  scope: "catalogs",
  composed: false,
  line: 4,
  servers: [{ target: "code", catalogId }],
  credentials: [
    {
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: null,
      readers: ["github"],
    },
  ],
  helpers: ["github_read_repo"],
  ...fields,
});
const emptyDeclarations = (
  fields: Partial<Declarations> = {},
): Declarations => ({
  batteries: [],
  unusedAliases: [],
  rootRevision: 3,
  lastError: null,
  managedInGithub: false,
  heldPull: null,
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

/** Every permission the panel asks about is held. */
function grantEverything() {
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
}

/** Holds each named resource and refuses the rest, per asked-for query. */
function grantOnly(...resources: (keyof Permissions)[]) {
  vi.mocked(useHasPermissions).mockImplementation(
    (query) =>
      ({
        data: Object.keys(query).every((resource) =>
          resources.includes(resource as keyof Permissions),
        ),
      }) as ReturnType<typeof useHasPermissions>,
  );
}

/** The batteries the coverage summary says fit a server. */
let fitting: { name: string; servers: string[]; tools: number }[] = [];

/**
 * The page's query string, which the router mock writes and `useSearchParams`
 * reads back, so a filter survives the navigation it causes as it would live.
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

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl });
  vi.mocked(usePathname).mockReturnValue("/openappa/batteries");
  url = new URLSearchParams();
  vi.mocked(useRouter).mockReturnValue({
    replace: vi.fn(navigate),
    push: vi.fn(navigate),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockImplementation(
    () => useUrl() as ReturnType<typeof useSearchParams>,
  );
  grantEverything();
  freshSynced = false;
  fitting = [];
  batteries = [githubBattery([install()])];
  declarations = emptyDeclarations({ batteries: [declaredGithub()] });
  server.use(
    http.get(`${baseUrl}/api/openappa/batteries`, () =>
      HttpResponse.json(batteries),
    ),
    http.get(`${baseUrl}/api/openappa/policy-declarations`, () =>
      HttpResponse.json(declarations),
    ),
    http.get(`${baseUrl}/api/internal_mcp_catalog`, () =>
      HttpResponse.json([
        { id: catalogId, name: "Code" },
        { id: otherCatalogId, name: "Docs" },
        { id: freshCatalogId, name: "Fresh" },
        { id: bareCatalogId, name: "Bare" },
      ]),
    ),
    http.get(`${baseUrl}/api/openappa/battery-matches`, ({ request }) => {
      const picked = new URL(request.url).searchParams.get("catalogId");
      return HttpResponse.json({
        attach:
          picked === freshCatalogId && !freshSynced ? "unsynced" : "ready",
        matches: [],
      });
    }),
    // Bare is in the catalog but nobody installed it.
    http.get(`${baseUrl}/api/mcp_server`, () =>
      HttpResponse.json(
        [
          { id: freshServerId, name: "Fresh", catalogId: freshCatalogId },
          {
            id: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
            name: "Code",
            catalogId,
          },
          {
            id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
            name: "Docs",
            catalogId: otherCatalogId,
          },
        ].map((install) => ({ ...install, createdAt: "2026-09-22T12:00:00Z" })),
      ),
    ),
    http.get(`${baseUrl}/api/credentials`, () =>
      HttpResponse.json([credential]),
    ),
    http.get(`${baseUrl}/api/openappa/coverage/summary`, () =>
      HttpResponse.json({
        totals: {
          tools: 0,
          root: 0,
          battery: 0,
          notEnforced: 0,
          catchAll: 0,
          builtInFallback: 0,
        },
        batteries: { active: [], broken: [], available: fitting },
      }),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.mocked(useHasPermissions).mockReset();
});
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
      <BatteriesUploadAction />
      <BatteriesPanel />
    </QueryClientProvider>,
  );
}

/**
 * The dialog's title is the battery's name, then its status badge; jsdom
 * joins the two with no space, where a browser separates the flex items.
 */
const dialogName = (name: string) => new RegExp(`^${name}(?![a-z0-9-])`);

/** Open the battery's dialog from its row, Edit or View as the reader may. */
const entry = async (name: string) => {
  if (!screen.queryByRole("dialog", { name: dialogName(name) })) {
    const open = await screen.findByRole("button", {
      name: new RegExp(`^(Edit|View) ${name}$`),
    });
    fireEvent.click(open);
  }
  return screen.findByRole("dialog", { name: dialogName(name) });
};

/** Pick a server in the battery's dialog and add it to the list. */
async function attach(battery: string, serverName: string) {
  const user = userEvent.setup();
  await entry(battery);
  await user.click(screen.getByRole("combobox", { name: "MCP server" }));
  await user.click(screen.getByRole("option", { name: serverName }));
  await user.click(await screen.findByRole("button", { name: "Attach" }));
}

/** Pick an item from the row's "More actions" menu. */
async function rowMenu(battery: string) {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: `More actions ${battery}` }),
  );
  return screen.findByRole("menu");
}

test("with no installed server to attach to, the attach form leads to MCP Registry", async () => {
  declarations = emptyDeclarations();
  server.use(
    http.get(`${baseUrl}/api/mcp_server`, () => HttpResponse.json([])),
  );
  show();
  expect(
    await screen.findByRole("link", { name: "Browse MCP servers" }),
  ).toHaveAttribute("href", "/mcp/registry");
  expect(
    screen.queryByRole("combobox", { name: "Battery" }),
  ).not.toBeInTheDocument();
});

test("an empty policy offers the installed servers to attach to", async () => {
  declarations = emptyDeclarations();
  show();
  const user = userEvent.setup();
  await entry("github");
  await user.click(screen.getByRole("combobox", { name: "MCP server" }));
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["Code", "Docs", "Fresh"]);
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("link", { name: "Browse MCP servers" }),
  ).not.toBeInTheDocument();
});

test("asks before discarding a battery upload draft", async () => {
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /upload package/i }),
  );
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Name")).toHaveValue("acme");
});

test("an included entry shows the status the declaration gives it", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ status: "active" })],
  });
  show();
  expect(await entry("github")).toHaveTextContent("Active");
  expect(await entry("github")).toHaveTextContent("Bundled");
});

test("clicking a battery's row opens its dialog", async () => {
  show();
  fireEvent.click(await screen.findByText("GitHub rules"));
  expect(
    await screen.findByRole("dialog", { name: dialogName("github") }),
  ).toBeVisible();
});

test("a failed composition degrades every status and says what broke", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ status: "active" })],
    lastError: "line 4: unknown battery",
  });
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "line 4: unknown battery",
  );
  const row = await entry("github");
  expect(row).toHaveTextContent("Not enforced");
  expect(row).not.toHaveTextContent("Active");
});

test("an uploaded entry names the package bytes it is pinned to", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ source: "upload", packageHash: uploadHash })],
  });
  show();
  expect(await entry("github")).toHaveTextContent(
    `Upload ${uploadHash.slice(0, 12)}`,
  );
});

test("a held pull naming only dropped batteries is accepted with policy permissions", async () => {
  let accepted = false;
  declarations = emptyDeclarations({
    heldPull: {
      contentHash: "b".repeat(64),
      sourceCommit: "c".repeat(40),
      reasons: ["drops_batteries"],
    },
  });
  grantOnly("organization", "toolPolicy");
  server.use(
    http.post(`${baseUrl}/api/openappa/github-sync/accept-held`, () => {
      accepted = true;
      declarations = emptyDeclarations();
      return HttpResponse.json({
        contentHash: "b".repeat(64),
        sourceCommit: "c".repeat(40),
        reasons: ["drops_batteries"],
        droppedBatteries: ["github"],
        changedVariables: [],
        status: { enabled: true, hasPolicy: true, source: null },
      });
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Accept repository text" }),
  );
  await waitFor(() => expect(accepted).toBe(true));
});

test("a held pull that moves credentials needs the credential permission", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub()],
    heldPull: {
      contentHash: "b".repeat(64),
      sourceCommit: "c".repeat(40),
      reasons: ["drops_batteries", "changes_credentials"],
    },
  });
  grantOnly("organization", "toolPolicy");
  show();
  await entry("github");
  expect(
    screen.queryByRole("button", { name: "Accept repository text" }),
  ).not.toBeInTheDocument();
});

test("binding a credential sends the entry's whole binding table", async () => {
  let body: unknown;
  const retained = {
    variable: "APPA_SECOND_TOKEN",
    key: "retained-token",
    readers: ["github"],
  };
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        credentials: [...declaredGithub().credentials, retained],
      }),
    ],
  });
  server.use(
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-1`,
      async ({ request }) => {
        body = await request.json();
        declarations = emptyDeclarations({
          batteries: [
            declaredGithub({
              status: "active",
              credentials: [
                retained,
                {
                  variable: "APPA_PROVIDER_GITHUB_TOKEN",
                  key: "github-token",
                  readers: ["github"],
                },
              ],
            }),
          ],
        });
        return HttpResponse.json(declarations.batteries[0]);
      },
    ),
  );
  show();
  const user = userEvent.setup();
  await entry("github");
  await user.click(
    await screen.findByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  );
  await user.click(screen.getByRole("option", { name: "GitHub token" }));
  await waitFor(() =>
    expect(body).toEqual({
      credentialBindings: {
        APPA_PROVIDER_GITHUB_TOKEN: "github-token",
        APPA_SECOND_TOKEN: "retained-token",
      },
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
    ).toHaveTextContent("GitHub token"),
  );
  expect(
    screen.getByRole("combobox", { name: "APPA_SECOND_TOKEN" }),
  ).toHaveTextContent("retained-token");
});

test("a variable another entry reads is never unset, and the row says so", async () => {
  let patched = false;
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        credentials: [
          {
            variable: "APPA_PROVIDER_GITHUB_TOKEN",
            key: "github-token",
            readers: ["github", "acme"],
          },
        ],
      }),
    ],
  });
  server.use(
    http.patch(`${baseUrl}/api/openappa/battery-installs/install-1`, () => {
      patched = true;
      return HttpResponse.json(declarations.batteries[0]);
    }),
  );
  show();
  const user = userEvent.setup();
  await entry("github");
  await user.click(
    await screen.findByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  );
  await user.click(screen.getByRole("option", { name: "Not bound" }));
  const row = await entry("github");
  await waitFor(() =>
    expect(within(row).getByRole("alert")).toBeInTheDocument(),
  );
  expect(patched).toBe(false);
  expect(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  ).toHaveTextContent("GitHub token");
});

test("attaching a second server carries the package hash the entry already names", async () => {
  let body: unknown;
  batteries = [
    {
      ...githubBattery([install({ packageHash: uploadHash })]),
      source: "upload",
      contentHash: "d".repeat(64),
    },
  ];
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ source: "upload", packageHash: uploadHash })],
  });
  server.use(
    http.post(
      `${baseUrl}/api/openappa/battery-installs`,
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(declarations.batteries[0]);
      },
    ),
  );
  show();
  await attach("github", "Docs");
  await waitFor(() =>
    expect(body).toEqual({
      batteryName: "github",
      catalogId: otherCatalogId,
      packageHash: uploadHash,
    }),
  );
});

test("attaching a bundled battery that is not included yet names no package", async () => {
  let body: unknown;
  declarations = emptyDeclarations();
  batteries = [githubBattery()];
  server.use(
    http.post(
      `${baseUrl}/api/openappa/battery-installs`,
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(declaredGithub());
      },
    ),
  );
  show();
  await attach("github", "Code");
  await waitFor(() =>
    expect(body).toEqual({ batteryName: "github", catalogId }),
  );
});

test("attaching a server enables credential binding and keeps saved changes visible", async () => {
  const writes: string[] = [];
  let binding: unknown;
  declarations = emptyDeclarations();
  batteries = [githubBattery()];
  server.use(
    http.post(`${baseUrl}/api/openappa/battery-installs`, () => {
      writes.push("attach");
      batteries = [githubBattery([install()])];
      declarations = emptyDeclarations({ batteries: [declaredGithub()] });
      return HttpResponse.json(declarations.batteries[0]);
    }),
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-1`,
      async ({ request }) => {
        writes.push("bind");
        binding = await request.json();
        declarations = emptyDeclarations({
          batteries: [
            declaredGithub({
              status: "active",
              credentials: [
                {
                  variable: "APPA_PROVIDER_GITHUB_TOKEN",
                  key: "github-token",
                  readers: ["github"],
                },
              ],
            }),
          ],
        });
        return HttpResponse.json(declarations.batteries[0]);
      },
    ),
  );
  show();
  const row = await entry("github");
  const select = within(row).getByRole("combobox", {
    name: "APPA_PROVIDER_GITHUB_TOKEN",
  });
  expect(select).toBeDisabled();
  await attach("github", "Code");
  await waitFor(() => expect(select).toBeEnabled());
  expect(row).toHaveTextContent("code__*");
  expect(writes).toEqual(["attach"]);
  const user = userEvent.setup();
  await user.click(select);
  await user.click(screen.getByRole("option", { name: "GitHub token" }));
  await waitFor(() => expect(writes).toEqual(["attach", "bind"]));
  expect(binding).toEqual({
    credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github-token" },
  });
  await waitFor(() => expect(row).toHaveTextContent("Active"));
  expect(select).toHaveTextContent("GitHub token");
  await user.click(within(row).getAllByRole("button", { name: "Close" })[0]);
  expect(
    screen.queryByText("Discard unsaved changes?"),
  ).not.toBeInTheDocument();
  expect(await entry("github")).toHaveTextContent("Active");
});

test("the credentials section links to where credentials are set up", async () => {
  show();
  const row = await entry("github");
  expect(
    within(row).getByRole("link", { name: /Manage credentials/ }),
  ).toHaveAttribute("href", "/settings/credentials");
});

/** A battery made of annotators alone: it governs the organization, not a server. */
const jevBattery = (installs: Install[] = []): Battery => ({
  name: "jev",
  description: "Jev annotator",
  source: "bundled",
  contentHash: null,
  namespaces: [],
  annotators: ["jev.tool-call"],
  scope: "organization",
  helpers: ["jev-annotator.py"],
  credentials: ["APPA_PROVIDER_JEV_API_KEY"],
  setup: null,
  installs,
});
const declaredJev = (fields: Partial<PolicyBattery> = {}): PolicyBattery => ({
  entry: "batteries/jev/appa.toml",
  name: "jev",
  source: "bundled",
  packageHash: null,
  status: "missing_credentials",
  scope: "organization",
  composed: true,
  line: 2,
  servers: [],
  credentials: [
    { variable: "APPA_PROVIDER_JEV_API_KEY", key: null, readers: ["jev"] },
  ],
  helpers: ["jev-annotator.py"],
  ...fields,
});

test("an organization battery can be included and removed without an installed server", async () => {
  let body: unknown;
  let removed = false;
  declarations = emptyDeclarations();
  batteries = [githubBattery(), jevBattery()];
  server.use(
    http.get(`${baseUrl}/api/mcp_server`, () => HttpResponse.json([])),
    http.post(
      `${baseUrl}/api/openappa/battery-installs`,
      async ({ request }) => {
        body = await request.json();
        batteries = [
          githubBattery(),
          jevBattery([
            install({ id: "jev-row", batteryName: "jev", catalogId: null }),
          ]),
        ];
        declarations = emptyDeclarations({ batteries: [declaredJev()] });
        return HttpResponse.json(declarations.batteries[0]);
      },
    ),
    http.delete(`${baseUrl}/api/openappa/battery-includes/jev`, () => {
      removed = true;
      batteries = [githubBattery(), jevBattery()];
      declarations = emptyDeclarations();
      return HttpResponse.json({ success: true });
    }),
  );
  show();
  const user = userEvent.setup();
  await entry("jev");
  expect(
    screen.queryByRole("combobox", { name: "MCP server" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("switch", { name: "Include in policy" }));
  await waitFor(() => expect(body).toEqual({ batteryName: "jev" }));
  const toggle = screen.getByRole("switch", { name: "Include in policy" });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toBeChecked();
  await user.click(toggle);
  await waitFor(() => expect(removed).toBe(true));
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(
    screen.getByRole("combobox", { name: "APPA_PROVIDER_JEV_API_KEY" }),
  ).toBeDisabled();
});

test("an included battery governing the organization says so and binds its credential on its one row", async () => {
  let body: unknown;
  batteries = [
    jevBattery([
      install({ id: "jev-row", batteryName: "jev", catalogId: null }),
    ]),
  ];
  declarations = emptyDeclarations({ batteries: [declaredJev()] });
  server.use(
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/jev-row`,
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(declaredJev({ status: "active" }));
      },
    ),
  );
  show();
  const row = await entry("jev");
  expect(
    within(row).getByRole("switch", { name: "Include in policy" }),
  ).toBeChecked();
  const user = userEvent.setup();
  await user.click(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_JEV_API_KEY" }),
  );
  await user.click(screen.getByRole("option", { name: "GitHub token" }));
  await waitFor(() =>
    expect(body).toEqual({
      credentialBindings: { APPA_PROVIDER_JEV_API_KEY: "github-token" },
    }),
  );
});

test("a battery governing the organization that no rule routes to says how to route it", async () => {
  batteries = [
    jevBattery([
      install({ id: "jev-row", batteryName: "jev", catalogId: null }),
    ]),
  ];
  declarations = emptyDeclarations({
    batteries: [declaredJev({ status: "unrouted" })],
  });
  show();
  const row = await entry("jev");
  expect(row).toHaveTextContent("Not used by any rule");
  expect(row).not.toHaveTextContent("Active");
  expect(within(row).getByRole("code")).toHaveTextContent(
    'annotator = "jev.tool-call"',
  );
});

test("a server whose tools are not synced yet cannot take a battery", async () => {
  declarations = emptyDeclarations();
  batteries = [githubBattery()];
  show();
  const user = userEvent.setup();
  await entry("github");
  await user.click(screen.getByRole("combobox", { name: "MCP server" }));
  await user.click(screen.getByRole("option", { name: "Fresh" }));
  expect(await screen.findByRole("note")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  // Syncing the picked server's tools is offered right there and, once it
  // lands, the same server can take the battery.
  let reloaded: string | null = null;
  server.use(
    http.post(`${baseUrl}/api/mcp_server/:id/reload-tools`, ({ params }) => {
      reloaded = String(params.id);
      freshSynced = true;
      return HttpResponse.json({
        created: 3,
        updated: 0,
        unchanged: 0,
        deleted: 0,
      });
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sync tools" }));
  await waitFor(() => expect(reloaded).toBe(freshServerId));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Attach" })).toBeEnabled(),
  );
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});

test("detaching a server deletes that server's install alone", async () => {
  let deleted: string | null = null;
  batteries = [
    githubBattery([
      install(),
      install({ id: "install-2", catalogId: otherCatalogId }),
    ]),
  ];
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        servers: [
          { target: "code", catalogId },
          { target: "docs", catalogId: otherCatalogId },
        ],
      }),
    ],
  });
  server.use(
    http.delete(
      `${baseUrl}/api/openappa/battery-installs/:id`,
      ({ params }) => {
        deleted = String(params.id);
        batteries = [githubBattery([install()])];
        declarations = emptyDeclarations({ batteries: [declaredGithub()] });
        return HttpResponse.json({ success: true });
      },
    ),
  );
  show();
  const row = await entry("github");
  fireEvent.click(
    await screen.findByRole("button", { name: "Detach github from Docs" }),
  );
  await waitFor(() => expect(deleted).toBe("install-2"));
  await waitFor(() =>
    expect(
      within(row).queryByRole("button", { name: "Detach github from Docs" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    within(row).getByRole("button", { name: "Detach github from Code" }),
  ).toBeVisible();
});

test("a failed readiness lookup for the picked server shows an error with a retry", async () => {
  declarations = emptyDeclarations();
  batteries = [githubBattery()];
  let attempts = 0;
  server.use(
    http.get(`${baseUrl}/api/openappa/battery-matches`, () => {
      attempts += 1;
      return attempts === 1
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({ attach: "ready", matches: [] });
    }),
  );
  show();
  const user = userEvent.setup();
  await entry("github");
  await user.click(screen.getByRole("combobox", { name: "MCP server" }));
  await user.click(screen.getByRole("option", { name: "Code" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Attach" })).toBeEnabled(),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("removing an entry takes its include out in one write", async () => {
  const removed: string[] = [];
  batteries = [
    githubBattery([
      install(),
      install({ id: "install-2", catalogId: otherCatalogId }),
    ]),
  ];
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        servers: [
          { target: "code", catalogId },
          { target: "docs", catalogId: otherCatalogId },
        ],
      }),
    ],
  });
  server.use(
    http.delete(
      `${baseUrl}/api/openappa/battery-includes/:name`,
      ({ params }) => {
        removed.push(String(params.name));
        return HttpResponse.json({ success: true });
      },
    ),
  );
  show();
  const user = userEvent.setup();
  await user.click(
    within(await rowMenu("github")).getByRole("menuitem", {
      name: "Remove from policy",
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(removed).toEqual(["github"]));
});

test("an entry bound to no server this deployment carries is removed the same way", async () => {
  const removed: string[] = [];
  batteries = [githubBattery()];
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        status: "server_missing",
        servers: [{ target: "gone", catalogId: null }],
      }),
    ],
  });
  server.use(
    http.delete(
      `${baseUrl}/api/openappa/battery-includes/:name`,
      ({ params }) => {
        removed.push(String(params.name));
        return HttpResponse.json({ success: true });
      },
    ),
  );
  show();
  const user = userEvent.setup();
  await user.click(
    within(await rowMenu("github")).getByRole("menuitem", {
      name: "Remove from policy",
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(removed).toEqual(["github"]));
});

test("a package the policy includes cannot be deleted", async () => {
  batteries = [
    {
      ...githubBattery([install({ packageHash: uploadHash })]),
      source: "upload",
      contentHash: uploadHash,
    },
  ];
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ source: "upload", packageHash: uploadHash })],
  });
  show();
  expect(
    within(await rowMenu("github")).getByRole("menuitem", {
      name: "Delete package",
    }),
  ).toHaveAttribute("aria-disabled", "true");
});

test("a package no entry names can be deleted", async () => {
  batteries = [
    {
      ...githubBattery(),
      name: "acme",
      source: "upload",
      contentHash: uploadHash,
      credentials: [],
    },
  ];
  declarations = emptyDeclarations();
  show();
  expect(
    within(await rowMenu("acme")).getByRole("menuitem", {
      name: "Delete package",
    }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

test("a personal-only credential is listed but cannot be bound", async () => {
  server.use(
    http.get(`${baseUrl}/api/credentials`, () =>
      HttpResponse.json([
        credential,
        {
          ...credential,
          id: "cred-2",
          key: "gh-real",
          name: "GH real",
          allowPersonal: true,
          allowOrganization: false,
          personalConfigured: true,
          organizationConfigured: false,
        },
      ]),
    ),
  );
  show();
  const row = await entry("github");
  const user = userEvent.setup();
  await user.click(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  );
  expect(
    await screen.findByRole("option", { name: "GH real (personal only)" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("option", { name: "GitHub token" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

test("a binding to a key the credential list no longer offers still reads as that key", async () => {
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        credentials: [
          {
            variable: "APPA_PROVIDER_GITHUB_TOKEN",
            key: "retired-token",
            readers: ["github"],
          },
        ],
      }),
    ],
  });
  show();
  const row = await entry("github");
  const select = within(row).getByRole("combobox", {
    name: "APPA_PROVIDER_GITHUB_TOKEN",
  });
  await waitFor(() => expect(select).toHaveTextContent("retired-token"));
});

test("a reader who cannot bind still sees which key a variable is bound to", async () => {
  grantOnly();
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub({
        credentials: [
          {
            variable: "APPA_PROVIDER_GITHUB_TOKEN",
            key: "github-token",
            readers: ["github"],
          },
        ],
      }),
    ],
  });
  show();
  const row = await entry("github");
  const select = within(row).getByRole("combobox", {
    name: "APPA_PROVIDER_GITHUB_TOKEN",
  });
  expect(select).toBeDisabled();
  await waitFor(() => expect(select).toHaveTextContent("github-token"));
});

test("a policy the repository owns is read-only", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub()],
    managedInGithub: true,
  });
  show();
  expect(
    await screen.findByRole("button", { name: "View github" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "More actions github" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /upload package/i }),
  ).not.toBeInTheDocument();
  const row = await entry("github");
  expect(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  ).toBeDisabled();
  expect(
    within(row).queryByRole("button", { name: /Detach|Attach/ }),
  ).not.toBeInTheDocument();
});

test("without the permission to manage guardrails the controls are read-only", async () => {
  grantOnly();
  show();
  expect(
    await screen.findByRole("button", { name: "View github" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "More actions github" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /upload package/i }),
  ).not.toBeInTheDocument();
  const row = await entry("github");
  expect(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  ).toBeDisabled();
  expect(
    within(row).queryByRole("button", { name: /Detach|Attach/ }),
  ).not.toBeInTheDocument();
});

test("uploading a package sends the picked files by their path inside the folder", async () => {
  let body: unknown;
  declarations = emptyDeclarations();
  batteries = [githubBattery()];
  server.use(
    http.put(
      `${baseUrl}/api/openappa/battery-packages/acme`,
      async ({ request }) => {
        body = await request.json();
        batteries = [
          githubBattery(),
          {
            ...githubBattery(),
            name: "acme",
            description: "Acme rules",
            source: "upload",
            contentHash: uploadHash,
            credentials: [],
          },
        ];
        return HttpResponse.json({
          name: "acme",
          description: "Acme rules",
          contentHash: uploadHash,
          entry: "acme",
          namespaces: [],
          helpers: [],
          credentials: [],
          setup: null,
        });
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
  const folderInput = screen.getByLabelText("Package folder");
  const openFolderPicker = vi.spyOn(folderInput, "click");
  expect(screen.getByRole("button", { name: "Choose folder" })).toBeVisible();
  fireEvent.click(screen.getByText("Select the whole package directory."));
  expect(openFolderPicker).toHaveBeenCalledOnce();
  const file = new File(["schema = 1"], "battery.toml", {
    type: "application/toml",
  });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "acme/battery.toml",
  });
  fireEvent.change(folderInput, {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  await waitFor(() =>
    expect(body).toEqual({
      files: [{ path: "battery.toml", text: "schema = 1" }],
    }),
  );
  expect(
    await screen.findByRole("button", { name: "More actions acme" }),
  ).toBeVisible();
});

test("an alias no entry declares is listed without a control to remove it", async () => {
  declarations = emptyDeclarations({
    unusedAliases: [{ namespace: "stripe", servers: ["billing"], line: 9 }],
  });
  show();
  await screen.findByText("stripe");
  expect(
    screen.queryByRole("button", { name: /stripe/i }),
  ).not.toBeInTheDocument();
});

test("search matches battery descriptions and clears the result set", async () => {
  declarations = emptyDeclarations();
  batteries = [
    githubBattery(),
    {
      ...githubBattery(),
      name: "docs",
      description: "Knowledge rules",
      namespaces: ["reference"],
    },
  ];
  show();
  const search = await screen.findByPlaceholderText(/Search batteries by name/);
  await userEvent.setup().type(search, "knowledge");
  expect(
    screen.getByRole("row", { name: /docs Knowledge rules/ }),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      screen.queryByRole("row", { name: /github GitHub rules/ }),
    ).not.toBeInTheDocument(),
  );
  await userEvent.setup().clear(search);
  expect(
    await screen.findByRole("row", { name: /github GitHub rules/ }),
  ).toBeVisible();
});

test("source and status filters narrow the battery table", async () => {
  declarations = emptyDeclarations({ batteries: [declaredGithub()] });
  batteries = [
    githubBattery([install()]),
    {
      ...githubBattery(),
      name: "custom",
      source: "upload",
      contentHash: uploadHash,
    },
  ];
  show();
  const user = userEvent.setup();
  await screen.findByRole("row", { name: /custom GitHub rules/ });
  await user.click(screen.getByRole("combobox", { name: "Filter by source" }));
  await user.click(screen.getByRole("option", { name: "Uploaded" }));
  expect(
    screen.getByRole("row", { name: /custom GitHub rules/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("row", { name: /github GitHub rules/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
  await user.click(screen.getByRole("option", { name: "Broken" }));
  expect(screen.getByText("No batteries match your filters")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(
    screen.getByRole("row", { name: /github GitHub rules/ }),
  ).toBeVisible();
});

test("the status filter groups statuses and keeps the group in the URL", async () => {
  declarations = emptyDeclarations({
    batteries: [
      declaredGithub(),
      { ...declaredGithub({ status: "active" }), name: "live" },
      { ...declaredGithub({ status: "unrouted" }), name: "idle" },
    ],
  });
  batteries = [
    githubBattery([install()]),
    { ...githubBattery(), name: "live", description: "Live rules" },
    { ...githubBattery(), name: "idle", description: "Idle rules" },
    { ...githubBattery(), name: "docs", description: "Knowledge rules" },
  ];
  show();
  const user = userEvent.setup();
  await screen.findByRole("row", { name: /docs Knowledge rules/ });
  await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
  await user.click(screen.getByRole("option", { name: "Broken" }));
  expect(url.get("status")).toBe("broken");
  // A missing credential and an unused battery are both broken.
  expect(
    screen.getByRole("row", { name: /github GitHub rules/ }),
  ).toBeVisible();
  expect(screen.getByRole("row", { name: /idle Idle rules/ })).toBeVisible();
  expect(
    screen.queryByRole("row", { name: /live Live rules/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("row", { name: /docs Knowledge rules/ }),
  ).not.toBeInTheDocument();
});

test("the available batteries split into the ones that fit a server and the rest", async () => {
  url = new URLSearchParams("status=fits");
  declarations = emptyDeclarations();
  fitting = [{ name: "docs", servers: ["Docs"], tools: 3 }];
  batteries = [
    githubBattery(),
    { ...githubBattery(), name: "docs", description: "Knowledge rules" },
  ];
  show();
  const docs = await screen.findByRole("row", { name: /docs Knowledge rules/ });
  expect(docs).toHaveTextContent("Fits your servers");
  expect(
    screen.queryByRole("row", { name: /github GitHub rules/ }),
  ).not.toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
  await user.click(screen.getByRole("option", { name: "Other available" }));
  expect(url.get("status")).toBe("other");
  expect(
    await screen.findByRole("row", { name: /github GitHub rules/ }),
  ).toHaveTextContent("Available");
  expect(
    screen.queryByRole("row", { name: /docs Knowledge rules/ }),
  ).not.toBeInTheDocument();
});

test("filters in the URL apply on load, so a reload or a link keeps them", async () => {
  url = new URLSearchParams("status=active&search=github");
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ status: "active" })],
  });
  batteries = [
    githubBattery([install()]),
    { ...githubBattery(), name: "docs", description: "Knowledge rules" },
  ];
  show();
  expect(
    await screen.findByRole("row", { name: /github GitHub rules/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("row", { name: /docs Knowledge rules/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Filter by status" }),
  ).toHaveTextContent("Active");
  expect(screen.getByPlaceholderText(/Search batteries by name/)).toHaveValue(
    "github",
  );
});

test("an unknown status in the URL shows every battery", async () => {
  url = new URLSearchParams("status=bogus");
  show();
  expect(
    await screen.findByRole("row", { name: /github GitHub rules/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Clear filters" }),
  ).not.toBeInTheDocument();
});

test("pagination shows the next page and search returns to the first", async () => {
  declarations = emptyDeclarations();
  batteries = Array.from({ length: 12 }, (_, index) => ({
    ...githubBattery(),
    name: `battery-${String(index + 1).padStart(2, "0")}`,
    description: `Rules ${index + 1}`,
  }));
  show();
  expect(
    await screen.findByRole("row", { name: /battery-01 Rules 1/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("row", { name: /battery-12 Rules 12/ }),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
  expect(
    screen.getByRole("row", { name: /battery-12 Rules 12/ }),
  ).toBeVisible();
  await userEvent
    .setup()
    .type(
      screen.getByPlaceholderText(/Search batteries by name/),
      "battery-01",
    );
  expect(
    await screen.findByRole("row", { name: /battery-01 Rules 1/ }),
  ).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: "Go to previous page" })[0],
  ).toBeDisabled();
});
