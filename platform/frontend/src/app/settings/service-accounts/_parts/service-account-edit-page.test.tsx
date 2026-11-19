import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
  useSetSettingsAction: () => () => undefined,
  useSetSettingsPageHeader: () => () => undefined,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useAllPermissions,
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import { account, baseHandlers, origin } from "./service-account.test-data";
import { ServiceAccountEditPage } from "./service-account-edit-page";

const updates: unknown[] = [];
const server = setupServer(
  ...baseHandlers,
  http.patch(`${origin}/api/service-accounts/:id`, async ({ request }) => {
    updates.push(await request.json());
    return HttpResponse.json({ ...account, ...(updates.at(-1) as object) });
  }),
);

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
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updates.length = 0;
});

test("saves a renamed account and returns to its page", async () => {
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountEditPage serviceAccountId={account.id} />);

  const name = await screen.findByLabelText("Display name");
  await user.clear(name);
  await user.type(name, "Automation runner");
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(updates).toEqual([
      {
        name: "Automation runner",
        description: null,
        icon: null,
        role: "member",
        labels: [],
      },
    ]),
  );
  expect(push).toHaveBeenCalledWith(`/settings/service-accounts/${account.id}`);
});

test("edits the description, and saves a blank one as cleared", async () => {
  server.use(
    http.get(`${origin}/api/service-accounts/:id`, () =>
      HttpResponse.json({
        ...account,
        description: "Posts deploy notes",
        tokens: [],
      }),
    ),
  );
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountEditPage serviceAccountId={account.id} />);

  const description = await screen.findByLabelText(/Description/);
  await waitFor(() => expect(description).toHaveValue("Posts deploy notes"));
  await user.clear(description);
  await user.type(description, "   ");
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(updates).toEqual([expect.objectContaining({ description: null })]),
  );
});

test("links a service account to a team", async () => {
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountEditPage serviceAccountId={account.id} />);

  await user.click(await screen.findByRole("combobox", { name: "Team" }));
  await user.click(await screen.findByRole("option", { name: "Platform" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(updates).toEqual([
      {
        name: "Automation worker",
        description: null,
        icon: null,
        role: "member",
        teamId: "team-platform",
        labels: [],
      },
    ]),
  );
});

test("saves added labels with the account", async () => {
  const user = userEvent.setup();
  renderWithClient(<ServiceAccountEditPage serviceAccountId={account.id} />);

  // Labels wait under Advanced while the account has none.
  await user.click(await screen.findByRole("button", { name: /Advanced/ }));
  await user.type(await screen.findByLabelText("Label key"), "environment");
  await user.type(screen.getByLabelText("Label value"), "preview");
  await user.click(screen.getByRole("button", { name: "Add label" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(updates).toEqual([
      {
        name: account.name,
        description: null,
        icon: null,
        role: "member",
        labels: [{ key: "environment", value: "preview" }],
      },
    ]),
  );
});

test("sends someone who may not update the account to its page", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: !permissions.serviceAccount?.includes("update"),
        isPending: false,
      }) as unknown as ReturnType<typeof useHasPermissions>,
  );
  renderWithClient(<ServiceAccountEditPage serviceAccountId={account.id} />);

  await waitFor(() =>
    expect(
      vi.mocked(useRouter).mock.results.at(-1)?.value.replace,
    ).toHaveBeenCalledWith(`/settings/service-accounts/${account.id}`),
  );
  expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();
});
