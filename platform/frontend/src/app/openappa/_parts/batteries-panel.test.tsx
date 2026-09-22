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
type Declarations =
  archestraApiTypes.GetOpenappaPolicyDeclarationsResponses["200"];
type PolicyBattery = Declarations["batteries"][number];

const baseUrl = "http://localhost:9000";
const catalogId = "5b6d2f1e-3c4a-4d5e-8f6a-7b8c9d0e1f2a";
const otherCatalogId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const uploadHash = "a".repeat(64);
const server = setupServer();
let batteries: Battery[];
let declarations: Declarations;

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

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl });
  grantEverything();
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
      ]),
    ),
    http.get(`${baseUrl}/api/credentials`, () =>
      HttpResponse.json([credential]),
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
      <BatteriesPanel />
    </QueryClientProvider>,
  );
}

const entry = (name: string) =>
  screen.findByRole("listitem", { name: `${name} battery` });

test("an included entry shows the status the declaration gives it", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ status: "active" })],
  });
  show();
  expect(await entry("github")).toHaveTextContent("Active");
  expect(await entry("github")).toHaveTextContent("Bundled");
});

test("a failed composition degrades every status and says what broke", async () => {
  declarations = emptyDeclarations({
    batteries: [declaredGithub({ status: "active" })],
    lastError: "line 4: unknown battery",
  });
  show();
  const row = await entry("github");
  expect(row).toHaveTextContent("Not enforced");
  expect(row).not.toHaveTextContent("Active");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "line 4: unknown battery",
  );
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
  await screen.findByRole("listitem", { name: "github battery" });
  expect(
    screen.queryByRole("button", { name: "Accept repository text" }),
  ).not.toBeInTheDocument();
});

test("binding a credential sends the entry's whole binding table", async () => {
  let body: unknown;
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
  await user.click(
    await screen.findByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  );
  await user.click(screen.getByRole("option", { name: "GitHub token" }));
  await waitFor(() =>
    expect(body).toEqual({
      credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github-token" },
    }),
  );
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
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("combobox", {
      name: "Attach the github battery to a server",
    }),
  );
  await user.click(screen.getByRole("option", { name: "Docs" }));
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
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("combobox", {
      name: "Attach the github battery to a server",
    }),
  );
  await user.click(screen.getByRole("option", { name: "Code" }));
  await waitFor(() =>
    expect(body).toEqual({ batteryName: "github", catalogId }),
  );
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
        return HttpResponse.json({ success: true });
      },
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Detach github from Docs" }),
  );
  await waitFor(() => expect(deleted).toBe("install-2"));
});

test("removing an entry deletes every install it has", async () => {
  const deleted: string[] = [];
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
        deleted.push(String(params.id));
        return HttpResponse.json({ success: true });
      },
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove the github battery" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(deleted).toEqual(["install-1", "install-2"]));
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
    await screen.findByRole("button", { name: "Delete the github package" }),
  ).toBeDisabled();
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
    await screen.findByRole("button", { name: "Delete the acme package" }),
  ).toBeEnabled();
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
  const row = await entry("github");
  expect(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Remove the github battery" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", {
      name: "Attach the github battery to a server",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /upload package/i }),
  ).not.toBeInTheDocument();
});

test("without the permission to manage guardrails the controls are read-only", async () => {
  grantOnly();
  show();
  const row = await entry("github");
  expect(
    within(row).getByRole("combobox", { name: "APPA_PROVIDER_GITHUB_TOKEN" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Remove the github battery" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /upload package/i }),
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
  await waitFor(() =>
    expect(body).toEqual({
      files: [{ path: "battery.toml", text: "schema = 1" }],
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Delete the acme package" }),
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
