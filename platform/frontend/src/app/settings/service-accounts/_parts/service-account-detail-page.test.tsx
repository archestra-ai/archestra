import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { type ReactNode, useSyncExternalStore } from "react";
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
// The page puts its main button and menu in the settings header; the test
// renders that slot beside the page so those controls can be clicked.
const headerAction = vi.hoisted(() => {
  let node: unknown = null;
  const listeners = new Set<() => void>();
  return {
    get: () => node,
    set: (next: unknown) => {
      node = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => headerAction.set,
  useSetSettingsPageHeader: () => () => undefined,
}));

function HeaderAction() {
  const node = useSyncExternalStore(headerAction.subscribe, headerAction.get);
  return <>{node as ReactNode}</>;
}

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useAllPermissions,
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import { account, baseHandlers, origin } from "./service-account.test-data";
import { ServiceAccountDetailPage } from "./service-account-detail-page";

const server = setupServer(...baseHandlers);

const push = vi.fn();
let searchParams = new URLSearchParams();

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
  headerAction.set(null);
  searchParams = new URLSearchParams();
  vi.mocked(useSearchParams).mockImplementation(
    () => searchParams as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue(
    `/settings/service-accounts/${account.id}`,
  );
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useScopedCapabilities>);
  vi.mocked(useAllPermissions).mockReturnValue({
    data: {},
  } as unknown as ReturnType<typeof useAllPermissions>);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
});

function renderWithClient(ui: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HeaderAction />
      {ui}
    </QueryClientProvider>,
  );
}

test("gives API keys and federated credentials a tab each", async () => {
  searchParams = new URLSearchParams({ tab: "api-keys" });
  const { unmount } = renderWithClient(
    <ServiceAccountDetailPage serviceAccountId={account.id} />,
  );
  expect(
    await screen.findByRole("button", { name: "Create key" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Add credential" }),
  ).not.toBeInTheDocument();
  unmount();

  searchParams = new URLSearchParams({ tab: "federated-credentials" });
  renderWithClient(<ServiceAccountDetailPage serviceAccountId={account.id} />);
  expect(
    await screen.findByRole("button", { name: "Add credential" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Create key" }),
  ).not.toBeInTheDocument();
});

test("searches API keys by name or key prefix and restores results after clearing", async () => {
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
  searchParams = new URLSearchParams({ tab: "api-keys" });
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountDetailPage serviceAccountId={account.id} />);

  expect(await screen.findByText("Deployment key")).toBeVisible();
  expect(screen.getByText("Backup key")).toBeVisible();
  // Each key shows its prefix under its name, the only part shown again.
  expect(screen.getByText("preview-1…")).toBeVisible();
  const search = screen.getByPlaceholderText("Search API keys by name and key");
  await user.type(search, "preview-1");
  await waitFor(() =>
    expect(screen.queryByText("Deployment key")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Backup key")).toBeVisible();
  await user.clear(search);
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

test("adds a federated credential with exact claim conditions", async () => {
  const created: unknown[] = [];
  const saved = (body: unknown, index: number) => ({
    ...(body as object),
    id: `00000000-0000-4000-8000-00000000000${index}`,
    serviceAccountId: account.id,
    lastUsedAt: null,
    createdAt: account.createdAt,
    updatedAt: account.createdAt,
  });
  server.use(
    http.get(`${origin}/api/service-accounts/:id/federated-credentials`, () =>
      HttpResponse.json(created.map(saved)),
    ),
    http.post(
      `${origin}/api/service-accounts/:id/federated-credentials`,
      async ({ request }) => {
        const body = await request.json();
        created.push(body);
        return HttpResponse.json(saved(body, created.length - 1));
      },
    ),
  );
  searchParams = new URLSearchParams({ tab: "federated-credentials" });
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountDetailPage serviceAccountId={account.id} />);
  expect(await screen.findByText("No federated credentials")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Add credential" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Add federated credential",
  });
  await user.type(within(dialog).getByLabelText("Name"), "infra apply");
  await user.type(
    within(dialog).getByLabelText("Subject"),
    "repo:acme/infra:environment:production",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Add condition" }),
  );
  await user.type(within(dialog).getByLabelText("Claim 1"), "repository");
  await user.type(within(dialog).getByLabelText("Value 1"), "acme/infra");
  await user.click(within(dialog).getByRole("button", { name: "Add" }));

  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]).toEqual({
    name: "infra apply",
    // GitHub Actions is the default provider.
    issuer: "https://token.actions.githubusercontent.com",
    audience: window.location.origin,
    subject: "repo:acme/infra:environment:production",
    claimConditions: { repository: "acme/infra" },
  });
  // A new credential shows, once, the request its workload signs in with.
  const added = await screen.findByRole("dialog", {
    name: "Federated credential added",
  });
  expect(
    within(added).getByText(/\/api\/workload-identity\/token/),
  ).toBeVisible();
  // The dialog's X and its footer button are both named Close.
  await user.click(within(added).getAllByRole("button", { name: "Close" })[0]);
  expect(await screen.findByText("infra apply")).toBeVisible();
  // The row names the subject it trusts and counts the extra claims.
  expect(
    screen.getByText("repo:acme/infra:environment:production"),
  ).toBeVisible();
  expect(screen.getByText("1 claim")).toBeVisible();
});

test("edits a federated credential from its row", async () => {
  const credential = {
    id: "00000000-0000-4000-8000-000000000001",
    serviceAccountId: account.id,
    name: "infra apply",
    issuer: "https://token.actions.githubusercontent.com",
    audience: origin,
    subject: "repo:acme/infra:ref:refs/heads/main",
    claimConditions: {},
    lastUsedAt: null,
    createdAt: account.createdAt,
    updatedAt: account.createdAt,
  };
  const updates: unknown[] = [];
  server.use(
    http.get(`${origin}/api/service-accounts/:id/federated-credentials`, () =>
      HttpResponse.json([credential]),
    ),
    http.patch(
      `${origin}/api/service-accounts/:id/federated-credentials/:credentialId`,
      async ({ request }) => {
        const body = await request.json();
        updates.push(body);
        return HttpResponse.json({ ...credential, ...(body as object) });
      },
    ),
  );
  searchParams = new URLSearchParams({ tab: "federated-credentials" });
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountDetailPage serviceAccountId={account.id} />);
  expect(await screen.findByText("None")).toBeVisible();

  await user.click(
    screen.getByRole("button", {
      name: "Edit federated credential infra apply",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Edit federated credential",
  });
  const name = within(dialog).getByLabelText("Name");
  await user.clear(name);
  await user.type(name, "infra apply on main");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({
    name: "infra apply on main",
    subject: credential.subject,
  });
});

test("keeps federated credentials behind the enterprise license", async () => {
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
  searchParams = new URLSearchParams({ tab: "federated-credentials" });
  renderWithClient(<ServiceAccountDetailPage serviceAccountId={account.id} />);

  expect(await screen.findByText(/need an enterprise license/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Add credential" }),
  ).not.toBeInTheDocument();
});
