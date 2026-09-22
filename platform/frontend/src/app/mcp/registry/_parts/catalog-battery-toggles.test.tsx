import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const baseUrl = "http://localhost:9000";
const catalogId = "5b6d2f1e-3c4a-4d5e-8f6a-7b8c9d0e1f2a";
const server = setupServer();
let matches: Match[];
let fetches = 0;
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
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  matches = [];
  fetches = 0;
  server.use(
    http.get(`${baseUrl}/api/openappa/battery-matches`, ({ request }) => {
      fetches += 1;
      expect(new URL(request.url).searchParams.get("catalogId")).toBe(
        catalogId,
      );
      return HttpResponse.json(matches);
    }),
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
  matches = [{ battery: "github", evidence: "host", install: install({}) }];
  server.use(
    http.patch(
      `${baseUrl}/api/openappa/battery-installs/install-1`,
      async ({ request }) => {
        expect(await request.json()).toEqual({ enabled: false });
        matches = [
          {
            battery: "github",
            evidence: "host",
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
  matches = [{ battery: "slack", evidence: "name", install: null }];
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
        matches = [{ battery: "slack", evidence: "name", install: created }];
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
  matches = [{ battery: "github", evidence: "host", install: null }];
  server.use(
    http.post(`${baseUrl}/api/openappa/battery-installs`, () => {
      matches = [
        {
          battery: "github",
          evidence: "host",
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
        matches = [{ battery: "github", evidence: "host", install: updated }];
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

test("a battery is off until the policy declares it, whatever matched it", async () => {
  matches = [{ battery: "linear", evidence: "host", install: null }];
  show();
  expect(
    await screen.findByRole("checkbox", { name: /linear/ }),
  ).not.toBeChecked();
});

test("renders nothing when the server matches no battery or guardrails v2 is off", async () => {
  matches = [{ battery: "github", evidence: "host", install: null }];
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
            { battery: "github", evidence: "host", install: null },
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
  matches = [{ battery: "github", evidence: "host", install: install({}) }];
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(
    await screen.findByRole("checkbox", { name: /github/ }),
  ).toBeDisabled();
});
