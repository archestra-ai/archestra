import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { useFeature } from "@/lib/config/config.query";
import { CatalogBatteryToggles } from "./catalog-battery-toggles";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("sonner");

type Match =
  archestraApiTypes.GetOpenappaBatteryMatchesResponses["200"][number];
type Install = NonNullable<Match["install"]>;
type Battery = archestraApiTypes.GetOpenappaBatteriesResponses["200"][number];
type Declarations =
  archestraApiTypes.GetOpenappaPolicyDeclarationsResponses["200"];
type PolicyBattery = Declarations["batteries"][number];

const baseUrl = "http://localhost:9000";
const catalogId = "5b6d2f1e-3c4a-4d5e-8f6a-7b8c9d0e1f2a";
const uploadedHash = "a".repeat(64);
const newerHash = "b".repeat(64);
const server = setupServer();
let matches: Match[];
let batteries: Battery[];
let declarations: Declarations;
let permissions: { manage: boolean; credential: boolean };
let fetches = 0;
const battery = (fields: Partial<Battery>): Battery => ({
  name: "github",
  description: "Guardrails for GitHub",
  source: "bundled",
  contentHash: null,
  namespaces: [],
  helpers: [],
  credentials: [],
  setup: null,
  installs: [],
  ...fields,
});
const declared = (fields: Partial<PolicyBattery>): PolicyBattery => ({
  entry: "batteries/github/appa.toml",
  name: "github",
  source: "bundled",
  packageHash: null,
  status: "active",
  line: 3,
  servers: [],
  credentials: [],
  helpers: [],
  ...fields,
});
const install = (fields: Partial<Install>): Install => ({
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
  status: "active",
  ...fields,
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl });
  vi.mocked(useFeature).mockReturnValue(true);
  permissions = { manage: true, credential: true };
  vi.mocked(useHasPermissions).mockImplementation(
    (requested) =>
      ({
        data: requested.credential
          ? permissions.credential
          : permissions.manage,
      }) as ReturnType<typeof useHasPermissions>,
  );
  matches = [];
  batteries = [];
  declarations = {
    batteries: [],
    unusedAliases: [],
    rootRevision: 1,
    lastError: null,
    managedInGithub: false,
    heldPull: null,
  };
  fetches = 0;
  server.use(
    http.get(`${baseUrl}/api/openappa/battery-matches`, ({ request }) => {
      fetches += 1;
      expect(new URL(request.url).searchParams.get("catalogId")).toBe(
        catalogId,
      );
      return HttpResponse.json(matches);
    }),
    http.get(`${baseUrl}/api/openappa/batteries`, () =>
      HttpResponse.json(batteries),
    ),
    http.get(`${baseUrl}/api/openappa/policy-declarations`, () =>
      HttpResponse.json(declarations),
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
  return render(
    <QueryClientProvider client={client}>
      <CatalogBatteryToggles catalogId={catalogId} />
    </QueryClientProvider>,
  );
}

test("an installed battery follows its install and is switched through it", async () => {
  matches = [
    {
      battery: "github",
      evidence: "host",
      targets: ["github"],
      install: install({}),
    },
  ];
  server.use(
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-1`,
      async ({ request }) => {
        expect(await request.json()).toEqual({ enabled: false });
        matches = [
          {
            battery: "github",
            evidence: "host",
            targets: ["github"],
            install: install({ enabled: false, status: "server_missing" }),
          },
        ];
        return HttpResponse.json(matches[0].install);
      },
    ),
  );
  show();
  const checkbox = await screen.findByRole("checkbox", { name: /github/ });
  expect(checkbox).toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /github/ })).not.toBeChecked(),
  );
});

test("a battery matched by name alone starts off and is installed when turned on", async () => {
  matches = [
    { battery: "slack", evidence: "name", targets: ["slack"], install: null },
  ];
  // Bundled and not included yet: the policy gets the pinned entry, no package.
  batteries = [battery({ name: "slack" })];
  server.use(
    http.post(
      `${baseUrl}/api/openappa/battery-installs`,
      async ({ request }) => {
        expect(await request.json()).toEqual({
          batteryName: "slack",
          catalogId,
        });
        const created = install({
          id: "install-2",
          batteryName: "slack",
          status: "missing_credentials",
        });
        matches = [
          {
            battery: "slack",
            evidence: "name",
            targets: ["slack"],
            install: created,
          },
        ];
        return HttpResponse.json(created);
      },
    ),
  );
  show();
  const checkbox = await screen.findByRole("checkbox", { name: /slack/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /slack/ })).toBeChecked(),
  );
  expect(screen.getByRole("link")).toHaveAttribute("href", "/openappa");
});

test("a choice made while another write installs the battery lands on its install", async () => {
  matches = [
    { battery: "github", evidence: "host", targets: ["github"], install: null },
  ];
  server.use(
    http.post(`${baseUrl}/api/openappa/battery-installs`, () => {
      matches = [
        {
          battery: "github",
          evidence: "host",
          targets: ["github"],
          install: install({
            id: "install-3",
            enabled: false,
            status: "server_missing",
          }),
        },
      ];
      return HttpResponse.json(
        {
          error: {
            message: "This battery is already installed for that catalog entry",
            type: "api_conflict_error",
          },
        },
        { status: 409 },
      );
    }),
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-3`,
      async ({ request }) => {
        expect(await request.json()).toEqual({ enabled: true });
        const updated = install({ id: "install-3" });
        matches = [
          {
            battery: "github",
            evidence: "host",
            targets: ["github"],
            install: updated,
          },
        ];
        return HttpResponse.json(updated);
      },
    ),
  );
  show();
  const checkbox = await screen.findByRole("checkbox", { name: /github/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /github/ })).toBeChecked(),
  );
});

test("a server whose tools are not synced yet cannot take a battery", async () => {
  matches = [
    { battery: "github", evidence: "host", targets: [], install: null },
  ];
  batteries = [battery({})];
  show();
  const checkbox = await screen.findByRole("checkbox", { name: /github/ });
  expect(checkbox).toBeDisabled();
  expect(screen.getByRole("note")).toBeInTheDocument();
});

test("a battery is off until the policy declares it, whatever matched it", async () => {
  matches = [
    { battery: "linear", evidence: "host", targets: ["linear"], install: null },
  ];
  show();
  expect(
    await screen.findByRole("checkbox", { name: /linear/ }),
  ).not.toBeChecked();
});

test("renders nothing when the server matches no battery or guardrails v2 is off", async () => {
  matches = [
    { battery: "github", evidence: "host", targets: ["github"], install: null },
  ];
  vi.mocked(useFeature).mockReturnValue(false);
  const { container, unmount } = show();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(container).toBeEmptyDOMElement();
  expect(fetches).toBe(0);
  unmount();
  vi.mocked(useFeature).mockReturnValue(true);
  matches = [];
  const second = show();
  await waitFor(() => expect(second.container).toBeEmptyDOMElement());
});

test("a failed lookup shows an error with a retry instead of nothing", async () => {
  let attempts = 0;
  server.use(
    http.get(`${baseUrl}/api/openappa/battery-matches`, () => {
      attempts += 1;
      return attempts === 1
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json([
            {
              battery: "github",
              evidence: "host",
              targets: ["github"],
              install: null,
            },
          ]);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("checkbox", { name: /github/ }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("the checkbox is read-only without the permission to manage guardrails", async () => {
  matches = [
    {
      battery: "github",
      evidence: "host",
      targets: ["github"],
      install: install({}),
    },
  ];
  permissions = { manage: false, credential: false };
  show();
  expect(
    await screen.findByRole("checkbox", { name: /github/ }),
  ).toBeDisabled();
});

test("a battery the policy already includes is added under that entry's package", async () => {
  matches = [
    { battery: "slack", evidence: "host", targets: ["slack"], install: null },
  ];
  // A newer upload exists, but the policy includes the battery once: the
  // create has to name the bytes the included entry spells.
  batteries = [
    battery({ name: "slack", source: "upload", contentHash: newerHash }),
  ];
  declarations.batteries = [
    declared({
      name: "slack",
      source: "upload",
      packageHash: uploadedHash,
      entry: `batteries/slack@sha256-${uploadedHash}/appa.toml`,
    }),
  ];
  let body: unknown;
  server.use(
    http.post(
      `${baseUrl}/api/openappa/battery-installs`,
      async ({ request }) => {
        body = await request.json();
        const created = install({
          id: "install-4",
          batteryName: "slack",
          packageHash: uploadedHash,
        });
        matches = [
          {
            battery: "slack",
            evidence: "host",
            targets: ["slack"],
            install: created,
          },
        ];
        return HttpResponse.json(created);
      },
    ),
  );
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: /slack/ }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /slack/ })).toBeChecked(),
  );
  expect(body).toEqual({
    batteryName: "slack",
    catalogId,
    packageHash: uploadedHash,
  });
});

test("an uploaded battery the policy does not include yet is added under its newest package", async () => {
  matches = [
    { battery: "slack", evidence: "host", targets: ["slack"], install: null },
  ];
  batteries = [
    battery({ name: "slack", source: "upload", contentHash: newerHash }),
  ];
  let body: unknown;
  server.use(
    http.post(
      `${baseUrl}/api/openappa/battery-installs`,
      async ({ request }) => {
        body = await request.json();
        const created = install({
          id: "install-5",
          batteryName: "slack",
          packageHash: newerHash,
        });
        matches = [
          {
            battery: "slack",
            evidence: "host",
            targets: ["slack"],
            install: created,
          },
        ];
        return HttpResponse.json(created);
      },
    ),
  );
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: /slack/ }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /slack/ })).toBeChecked(),
  );
  expect(body).toEqual({
    batteryName: "slack",
    catalogId,
    packageHash: newerHash,
  });
});

test("a battery with a credential says who has to bind it only when the reader cannot", async () => {
  matches = [
    {
      battery: "github",
      evidence: "host",
      targets: ["github"],
      install: install({}),
    },
  ];
  batteries = [battery({ credentials: ["APPA_PROVIDER_GITHUB_TOKEN"] })];
  const { unmount } = show();
  await screen.findByRole("checkbox", { name: /github/ });
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  unmount();

  permissions = { manage: true, credential: false };
  show();
  const note = await screen.findByRole("note");
  expect(within(note).getByRole("link")).toHaveAttribute("href", "/openappa");
});
