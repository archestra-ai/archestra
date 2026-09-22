// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient, type ScopedResource } from "@archestra/shared";
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
  it,
  vi,
} from "vitest";
import type { ResourcePermissions as Policy } from "@/lib/resource-permissions.query";
import { ResourceListActions } from "./resource-list-actions";
import { DropdownMenuItem } from "./ui/dropdown-menu";

const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => "/agents",
  useRouter: () => ({ replace: navigation.replace }),
}));
const origin = "http://localhost:9000";
const server = setupServer();
let policy: Policy;
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  navigation.search = "";
  navigation.replace.mockReset();
  archestraApiClient.setConfig({ baseUrl: origin });
  policy = {
    resource: "agent",
    scope: "*",
    name: "All agents",
    revision: 1,
    grants: [
      {
        subject: { type: "team", id: "support" },
        name: "Support",
        actions: ["read"],
      },
    ],
    inheritedGrants: [],
    effectiveActions: ["read", "use", "update", "delete", "manage-permissions"],
  };
  server.use(
    http.get(
      `${origin}/api/resource-permissions/:resource/:scope`,
      ({ params }) => {
        expect(params.scope).toBe("*");
        expect(params.resource).toBe(policy.resource);
        return HttpResponse.json(policy);
      },
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderActions({
  resource = "agent",
  scope = "*",
  secondary = false,
}: {
  resource?: ScopedResource;
  scope?: string;
  secondary?: boolean;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["auth", "session"], { user: { id: "reviewer" } });
  client.setQueryData(
    ["scoped-capabilities"],
    [{ resource, scope, action: "read" }],
  );
  render(
    <QueryClientProvider client={client}>
      <ResourceListActions resource={resource}>
        {secondary ? <DropdownMenuItem>Import Agent</DropdownMenuItem> : null}
      </ResourceListActions>
    </QueryClientProvider>,
  );
  return client;
}

it("edits only the all-agents policy and guards dismissing unsaved changes", async () => {
  const writes: unknown[] = [];
  server.use(
    http.put(
      `${origin}/api/resource-permissions/agent/:scope`,
      async ({ request, params }) => {
        expect(params.scope).toBe("*");
        const body = (await request.json()) as {
          revision: number;
          grants: Policy["grants"];
        };
        writes.push(body);
        policy = {
          ...policy,
          revision: 2,
          grants: body.grants.map((g) => ({ ...g, name: "Support" })),
        };
        return HttpResponse.json(policy);
      },
    ),
    http.get(`${origin}/api/resource-permissions`, () =>
      HttpResponse.json([{ resource: "agent", scope: "*", action: "read" }]),
    ),
  );
  renderActions();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Permissions" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Permissions for all agents",
  });
  expect(dialog).toHaveTextContent("including ones created later");
  await user.click(
    await within(dialog).findByRole("combobox", {
      name: "Permission for Support",
    }),
  );
  await user.click(screen.getByRole("option", { name: /Can edit/ }));
  const footer = within(dialog).getByRole("group", {
    name: "Permission actions",
  });
  expect(footer).toHaveTextContent("Unsaved changes");
  expect(
    within(footer).getByRole("button", { name: "Save permissions" }),
  ).toBeEnabled();
  expect(
    within(footer).getByRole("button", { name: "Discard changes" }),
  ).toBeEnabled();
  expect(
    within(dialog).queryByRole("button", { name: "Done" }),
  ).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toHaveTextContent("Discard unsaved changes");
  expect(writes).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  await user.click(
    within(footer).getByRole("button", { name: "Discard changes" }),
  );
  expect(within(footer).getByRole("button", { name: "Done" })).toBeEnabled();
  expect(
    within(footer).queryByRole("button", { name: "Save permissions" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Permission for Support" }),
  ).toHaveTextContent("Can view");
  await user.click(
    within(dialog).getByRole("combobox", { name: "Permission for Support" }),
  );
  await user.click(screen.getByRole("option", { name: /Can edit/ }));

  await user.click(
    within(dialog).getByRole("button", { name: "Save permissions" }),
  );
  await waitFor(() =>
    expect(writes).toEqual([
      {
        revision: 1,
        grants: [
          {
            subject: { type: "team", id: "support" },
            actions: ["read", "use", "update"],
          },
        ],
      },
    ]),
  );
  await waitFor(() =>
    expect(
      within(dialog).queryByText("Unsaved changes"),
    ).not.toBeInTheDocument(),
  );
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not offer all-resource permissions to a recipient with only individual access", async () => {
  renderActions({
    scope: "00000000-0000-4000-8000-000000000010",
    secondary: true,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More actions" }));
  expect(
    screen.getByRole("menuitem", { name: "Import Agent" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Permissions" }),
  ).not.toBeInTheDocument();
});

it("opens a linked read-only permissions dialog for the current resource and preserves list filters on close", async () => {
  policy = { ...policy, resource: "skill", effectiveActions: ["read"] };
  navigation.search = "permissions=all&search=example";
  renderActions({ resource: "skill" });
  const dialog = await screen.findByRole("dialog", {
    name: "Permissions for all skills",
  });
  await within(dialog).findByText("Support");
  expect(
    within(dialog).queryByRole("button", { name: "Add access" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Permission for Support" }),
  ).toBeDisabled();
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Done" }));
  expect(navigation.replace).toHaveBeenCalledWith("/agents?search=example", {
    scroll: false,
  });
});

it("adds recipients in the same dialog and preserves the permission draft when going back", async () => {
  server.use(
    http.get(`${origin}/api/resource-permissions/agent/:scope/subjects`, () =>
      HttpResponse.json([
        { subject: { type: "team", id: "design" }, name: "Design" },
      ]),
    ),
  );
  renderActions();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Permissions" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Permissions for all agents",
  });
  await user.click(
    await within(dialog).findByRole("combobox", {
      name: "Permission for Support",
    }),
  );
  await user.click(screen.getByRole("option", { name: /Can edit/ }));
  await user.click(within(dialog).getByRole("button", { name: "Add access" }));
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Add access" })).toBe(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  expect(
    within(dialog).getByRole("combobox", { name: "Permission for Support" }),
  ).toHaveTextContent("Can edit");
  await user.click(within(dialog).getByRole("button", { name: "Add access" }));
  await user.click(within(dialog).getByRole("button", { name: /^Teams/ }));
  await user.click(within(dialog).getByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Design/ }));
  await user.click(within(dialog).getByRole("button", { name: "Add access" }));
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(
    screen.getByRole("dialog", { name: "Permissions for all agents" }),
  ).toBe(dialog);
  expect(
    within(dialog).getByRole("combobox", { name: "Permission for Support" }),
  ).toHaveTextContent("Can edit");
  expect(
    within(dialog).getByRole("combobox", { name: "Permission for Design" }),
  ).toHaveTextContent("Can view");
  const footer = within(dialog).getByRole("group", {
    name: "Permission actions",
  });
  expect(
    within(footer).getByRole("button", { name: "Save permissions" }),
  ).toBeEnabled();
  await user.click(
    within(footer).getByRole("button", { name: "Discard changes" }),
  );
  expect(
    within(dialog).queryByRole("combobox", { name: "Permission for Design" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Permission for Support" }),
  ).toHaveTextContent("Can view");
});
