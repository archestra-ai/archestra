import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
vi.mock("@/lib/config/config.query");
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
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import {
  account,
  baseHandlers,
  origin,
} from "./_parts/service-account.test-data";
import ServiceAccountsSettingsPage from "./page";

const server = setupServer(...baseHandlers);
const push = vi.fn();

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
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/settings/service-accounts");
  vi.mocked(useRouter).mockReturnValue({
    push,
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
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
});

test("opens an account's page from its row and its editor from the pencil", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByText("Never used"));
  expect(push).toHaveBeenCalledWith(`/settings/service-accounts/${account.id}`);

  await user.click(
    screen.getByRole("button", {
      name: "Edit service account Automation worker",
    }),
  );
  expect(push).toHaveBeenLastCalledWith(
    `/settings/service-accounts/${account.id}/edit`,
  );
});

test("marks an account that has a description and reveals it on hover", async () => {
  server.use(
    http.get(`${origin}/api/service-accounts`, () =>
      HttpResponse.json([
        { ...account, description: "Posts release notes to the team channel" },
        { ...account, id: "account-2", name: "Plain account" },
      ]),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  const note = await screen.findByRole("button", {
    name: "Description: Posts release notes to the team channel",
  });
  // Only the account that has one is marked.
  expect(screen.getAllByRole("button", { name: /^Description:/ })).toHaveLength(
    1,
  );
  await user.hover(note);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Posts release notes to the team channel",
  );
  // Hovering or clicking the note does not open the account.
  await user.click(note);
  expect(push).not.toHaveBeenCalled();
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

function renderPage() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServiceAccountsSettingsPage />
    </QueryClientProvider>,
  );
}

function mockServiceAccountGrants(
  grants: { resource: string; action: string; scope: string }[],
) {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: grants,
  } as unknown as ReturnType<typeof useScopedCapabilities>);
}
