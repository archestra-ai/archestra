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
  icon: null,
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
      { name: "Automation runner", icon: null, role: "member", labels: [] },
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
        icon: null,
        role: "member",
        teamId: "team-platform",
        labels: [],
      },
    ]),
  );
});

test("shows key guidance and the request example after the table", async () => {
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
    /Keys let scripts and integrations call the/,
  );
  const example = within(dialog).getByText(
    /Authenticate a request as this service account/,
  );
  const table = within(dialog).getByRole("table");
  expect(
    table.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    table.compareDocumentPosition(example) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("keeps label drafts when Advanced collapses and saves them with the account", async () => {
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
  expect(within(dialog).getByLabelText("Label key")).not.toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Advanced" }));
  await user.type(within(dialog).getByLabelText("Label key"), "environment");
  await user.type(within(dialog).getByLabelText("Label value"), "preview");
  await user.click(within(dialog).getByRole("button", { name: "Advanced" }));
  expect(within(dialog).getByLabelText("Label key")).not.toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "API keys" }));
  await user.click(within(dialog).getByRole("button", { name: "General" }));
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(updates).toEqual([
      {
        name: account.name,
        icon: null,
        role: "member",
        labels: [{ key: "environment", value: "preview" }],
      },
    ]),
  );
});

test("explains missing keys through a compact sidebar tooltip", async () => {
  server.use(
    http.get(`${origin}/api/service-accounts/:id`, () =>
      HttpResponse.json({
        ...account,
        tokenCount: 0,
        activeTokenCount: 0,
        tokens: [],
      }),
    ),
  );
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
  await user.click(await screen.findByRole("button", { name: account.name }));
  const dialog = screen.getByRole("dialog", { name: "Edit service account" });
  const indicator = await within(dialog).findByRole("img", {
    name: "API key status",
  });
  expect(
    within(dialog).queryByText("This service account cannot authenticate"),
  ).not.toBeInTheDocument();
  expect(within(dialog).queryByText("No keys")).not.toBeInTheDocument();
  await user.hover(indicator);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "This service account has no API keys, so it cannot authenticate. Create one to start using it.",
  );
});

test("summarizes multiple roles and reveals the full assignment in a tooltip", async () => {
  server.use(
    http.get(`${origin}/api/service-accounts`, () =>
      HttpResponse.json([
        { ...account, role: "member,admin,platform_admin,editor" },
      ]),
    ),
  );
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
  const roles = await screen.findByRole("button", {
    name: "View assigned roles: Member, Admin, Platform Admin, Editor",
  });
  expect(roles).toHaveTextContent("Member+3");
  await user.hover(roles);
  const tooltip = await screen.findByRole("tooltip");
  for (const name of ["Member", "Admin", "Platform Admin", "Editor"])
    expect(within(tooltip).getByText(name)).toBeVisible();
});

test("read-only viewers can expand labels without being allowed to edit them", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: !permissions.serviceAccount?.includes("update"),
        isPending: false,
      }) as unknown as ReturnType<typeof useHasPermissions>,
  );
  server.use(
    http.get(`${origin}/api/service-accounts`, () =>
      HttpResponse.json([
        { ...account, labels: [{ key: "environment", value: "preview" }] },
      ]),
    ),
  );
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
  await user.click(await screen.findByRole("button", { name: account.name }));
  const dialog = screen.getByRole("dialog", { name: "Edit service account" });
  const advanced = within(dialog).getByRole("button", { name: "Advanced" });
  expect(advanced).toBeEnabled();
  await user.click(advanced);
  expect(within(dialog).getByText("environment:")).toBeVisible();
  expect(within(dialog).getByLabelText("Label key")).toBeDisabled();
  expect(
    within(dialog).getByRole("button", { name: "Remove label" }),
  ).toBeDisabled();
  expect(
    within(dialog).queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
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

test("searches API key names and restores results after clearing", async () => {
  const tokens = ["Deployment key", "Backup key"].map((name, index) => ({
    id: `key-${index}`,
    name,
    tokenStart: `preview-${index}`,
    disabled: false,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: account.createdAt,
  }));
  server.use(
    http.get(`${origin}/api/service-accounts/:id`, () =>
      HttpResponse.json({
        ...account,
        tokens,
        tokenCount: 2,
        activeTokenCount: 2,
      }),
    ),
  );
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
  await user.click(await screen.findByRole("button", { name: account.name }));
  await user.click(screen.getByRole("button", { name: "API keys" }));
  expect(await screen.findByText("Deployment key")).toBeVisible();
  expect(screen.getByText("Backup key")).toBeVisible();
  const search = screen.getByPlaceholderText("Search API keys by name");
  await user.type(search, "DEPLOY");
  await waitFor(() =>
    expect(screen.queryByText("Backup key")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Deployment key")).toBeVisible();
  await user.clear(search);
  expect(await screen.findByText("Backup key")).toBeVisible();
  await user.type(search, "unknown");
  expect(
    await screen.findByText("No API keys match your filters"),
  ).toBeVisible();
});

function mockServiceAccountGrants(
  grants: { resource: string; action: string; scope: string }[],
) {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: grants,
  } as unknown as ReturnType<typeof useScopedCapabilities>);
}
