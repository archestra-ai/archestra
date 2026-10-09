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
  test,
  vi,
} from "vitest";

// Radix Select uses pointer capture and scrolling APIs that jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: vi.fn(() => () => undefined),
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useAllPermissions,
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import ServiceAccountsSettingsPage from "./page";

const origin = "http://localhost:9000";
const account = {
  id: "account-1",
  organizationId: "org-1",
  name: "Automation worker",
  role: "member",
  teamId: null,
  disabled: false,
  tokenCount: 1,
  activeTokenCount: 1,
  soonestExpiryAt: null,
  lastUsedAt: null,
  labels: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdBy: null,
};
const updates: unknown[] = [];
const server = setupServer(
  http.get(`${origin}/api/service-accounts`, () =>
    HttpResponse.json([account]),
  ),
  http.get(`${origin}/api/service-accounts/:id`, () =>
    HttpResponse.json({ ...account, tokens: [] }),
  ),
  http.get(`${origin}/api/service-accounts/labels/keys`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${origin}/api/roles`, () => HttpResponse.json([])),
  http.get(`${origin}/api/teams`, () =>
    HttpResponse.json({
      data: [{ id: "team-platform", name: "Platform" }],
      pagination: {
        currentPage: 1,
        limit: 100,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    }),
  ),
  http.patch(`${origin}/api/service-accounts/:id`, async ({ request }) => {
    updates.push(await request.json());
    return HttpResponse.json({ ...account, ...(updates.at(-1) as object) });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/settings/service-accounts");
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  mockServiceAccountGrants([
    { resource: "serviceAccount", action: "update", scope: account.id },
  ]);
  vi.mocked(useAllPermissions).mockReturnValue({
    data: {},
  } as unknown as ReturnType<typeof useAllPermissions>);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
});

test("edits a service account from its table action", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServiceAccountsSettingsPage />
    </QueryClientProvider>,
  );

  await user.click(
    await screen.findByRole("button", {
      name: "Edit service account Automation worker",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit service account" });
  await user.clear(within(dialog).getByLabelText("Display name"));
  await user.type(
    within(dialog).getByLabelText("Display name"),
    "Automation runner",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(updates).toEqual([
      { name: "Automation runner", role: "member", labels: [] },
    ]),
  );
});

test("links a service account to a team", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServiceAccountsSettingsPage />
    </QueryClientProvider>,
  );

  await user.click(
    await screen.findByRole("button", {
      name: "Edit service account Automation worker",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit service account" });
  await user.click(within(dialog).getByRole("combobox", { name: "Team" }));
  await user.click(await screen.findByRole("option", { name: "Platform" }));
  await user.click(within(dialog).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(updates).toEqual([
      {
        name: "Automation worker",
        role: "member",
        teamId: "team-platform",
        labels: [],
      },
    ]),
  );
});

test("shows key guidance in the header and the request example after the table", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServiceAccountsSettingsPage />
    </QueryClientProvider>,
  );

  await user.click(
    await screen.findByRole("button", {
      name: "Edit service account Automation worker",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit service account" });
  await user.click(within(dialog).getByRole("button", { name: "API keys" }));

  const guidance = within(dialog).getByText(
    /Keys that let scripts and integrations call the/,
  );
  const example = within(dialog).getByText(
    /Authenticate a request as this service account/,
  );
  const table = within(dialog).getByRole("table");
  expect(
    guidance.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    table.compareDocumentPosition(example) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("offers row edits only on accounts the user holds an update grant for", async () => {
  mockServiceAccountGrants([
    { resource: "serviceAccount", action: "update", scope: "another-account" },
  ]);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServiceAccountsSettingsPage />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Automation worker")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: "Edit service account Automation worker",
    }),
  ).not.toBeInTheDocument();
});

function mockServiceAccountGrants(
  grants: { resource: string; action: string; scope: string }[],
) {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: grants,
  } as unknown as ReturnType<typeof useScopedCapabilities>);
}
