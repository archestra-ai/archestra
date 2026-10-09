// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
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
  it,
  vi,
} from "vitest";
import type { ResourcePermissions as Policy } from "@/lib/resource-permissions.query";
import { ResourcePermissions } from "./resource-permissions";

const origin = "http://localhost:9000";
const endpoint = `${origin}/api/resource-permissions/mcpRegistry/00000000-0000-4000-8000-000000000010`;
const server = setupServer();
let policy: Policy;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  policy = {
    resource: "mcpRegistry",
    scope: "00000000-0000-4000-8000-000000000010",
    name: "Example server",
    ownerId: null,
    revision: 1,
    grants: [
      {
        subject: {
          type: "serviceAccount",
          id: "00000000-0000-4000-8000-000000000011",
        },
        name: "Build automation",
        actions: ["read", "use"],
      },
    ],
    inheritedGrants: [
      {
        subject: { type: "team", id: "team-a" },
        name: "Engineering",
        actions: ["read"],
      },
    ],
    effectiveActions: ["read", "use", "update", "delete", "manage-permissions"],
  };
  server.use(
    http.get(endpoint, () => HttpResponse.json(policy)),
    http.get(`${endpoint}/subjects`, () => HttpResponse.json([])),
    http.get(`${origin}/api/resource-permissions/mcpRegistry/:scope`, () =>
      HttpResponse.json({
        ...policy,
        scope: "*",
        grants: [],
        effectiveActions: [],
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderEditor(onParentSubmit?: () => void, canManageGlobal = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["auth", "session"], { user: { id: "reviewer" } });
  client.setQueryData(
    ["auth", "userPermissions"],
    canManageGlobal ? { accessPolicies: ["read", "update"] } : {},
  );
  const editor = (
    <ResourcePermissions
      resource="mcpRegistry"
      scope={policy.scope}
      embedded={!!onParentSubmit}
    />
  );
  const view = render(
    <QueryClientProvider client={client}>
      {onParentSubmit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onParentSubmit();
          }}
        >
          {editor}
        </form>
      ) : (
        editor
      )}
    </QueryClientProvider>,
  );
  return { ...view, client };
}

it("preserves an unsaved draft when a background refresh fails", async () => {
  const user = userEvent.setup();
  const { client } = renderEditor();
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for Build automation",
    }),
  );
  server.use(http.get(endpoint, () => new HttpResponse(null, { status: 503 })));
  await client.invalidateQueries({ queryKey: ["resource-permissions"] });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
  );
  expect(screen.queryByText("Build automation")).not.toBeInTheDocument();
  server.use(http.get(endpoint, () => HttpResponse.json(policy)));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled(),
  );
  expect(screen.queryByText("Build automation")).not.toBeInTheDocument();
});

it("refreshes a clean editor without reporting a conflicting draft", async () => {
  const { client } = renderEditor();
  await screen.findByText("Build automation");
  policy = { ...policy, revision: 2, grants: [] };
  await client.invalidateQueries({ queryKey: ["resource-permissions"] });
  await waitFor(() =>
    expect(screen.queryByText("Build automation")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("button", { name: "Discard draft and reload" }),
  ).not.toBeInTheDocument();
});

it("revokes a service account's direct grant", async () => {
  let submitted: unknown;
  server.use(
    http.put(endpoint, async ({ request }) => {
      submitted = await request.json();
      policy = { ...policy, revision: 2, grants: [] };
      return HttpResponse.json(policy);
    }),
  );
  const user = userEvent.setup();
  renderEditor();
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for Build automation",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(submitted).toEqual({ revision: 1, grants: [] }));
  // Saving clears the draft, and with nothing left to save the control rests.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
  );
});

it("saves embedded permissions without submitting the surrounding settings form", async () => {
  let parentSubmissions = 0;
  let saved = false;
  server.use(
    http.put(endpoint, async () => {
      saved = true;
      policy = { ...policy, revision: 2, grants: [] };
      return HttpResponse.json(policy);
    }),
  );
  const user = userEvent.setup();
  renderEditor(() => {
    parentSubmissions += 1;
  });
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for Build automation",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save permissions" }));
  await waitFor(() => expect(saved).toBe(true));
  expect(parentSubmissions).toBe(0);
});

it("retains a stale draft and requires an explicit reload after a concurrent edit", async () => {
  server.use(
    http.put(endpoint, () => {
      policy = {
        ...policy,
        revision: 2,
        grants: [
          {
            ...policy.grants[0],
            name: "Updated automation",
            actions: ["read"],
          },
        ],
      };
      return HttpResponse.json(
        {
          error: {
            message:
              "Permissions changed since you opened this editor. Reload before saving.",
          },
        },
        { status: 409 },
      );
    }),
  );
  const user = userEvent.setup();
  renderEditor();
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for Build automation",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Updated automation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Discard draft and reload" }),
  );
  expect(screen.getByText("Updated automation")).toBeInTheDocument();
});

it("requires confirmation before saving a mock permission handoff", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
  policy.previewActorSubjects = [{ type: "role", id: "admin" }];
  policy.grants = [
    {
      subject: { type: "role", id: "admin" },
      name: "Admin",
      actions: [...policy.effectiveActions],
    },
    {
      subject: { type: "team", id: "team-b" },
      name: "Platform maintainers",
      actions: [...policy.effectiveActions],
    },
  ];
  let saves = 0;
  server.use(
    http.put(endpoint, async () => {
      saves++;
      return HttpResponse.json(policy);
    }),
  );
  const user = userEvent.setup();
  renderEditor();
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for Admin",
    }),
  );
  expect(screen.getByText("You’ll lose access.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByRole("dialog", { name: "Give up your access?" }),
  ).toBeInTheDocument();
  expect(saves).toBe(0);
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(saves).toBe(0);
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await user.click(
    await screen.findByRole("button", { name: "Save and give up access" }),
  );
  await waitFor(() => expect(saves).toBe(1));
});

it("blocks a mock policy edit that would remove its last manager", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
  policy.previewActorSubjects = [{ type: "role", id: "admin" }];
  policy.grants = [
    {
      subject: { type: "role", id: "admin" },
      name: "Admin",
      actions: [...policy.effectiveActions],
    },
  ];
  const user = userEvent.setup();
  renderEditor(() => {});
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for Admin",
    }),
  );
  expect(
    screen.getByText("Someone must be able to change permissions."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save permissions" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(
    await screen.findByRole("button", {
      name: "Remove direct access for Admin",
    }),
  ).toBeEnabled();
  expect(
    screen.queryByText("Someone must be able to change permissions."),
  ).not.toBeInTheDocument();
});

it("lets readers inspect grants without offering mutations", async () => {
  policy.effectiveActions = ["read"];
  renderEditor();
  await screen.findByText("Build automation");
  expect(screen.getByText("You can’t change permissions.")).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Permission for Build automation" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Add access" }),
  ).not.toBeInTheDocument();
  // The audience still shows, read off the saved grants.
  expect(screen.getByTestId("audience-chip")).toHaveTextContent("Personal");
});

it("moves the audience chip with the draft grants before saving", async () => {
  server.use(
    http.get(`${endpoint}/subjects`, () =>
      HttpResponse.json([
        { subject: { type: "team", id: "team-a" }, name: "Engineering" },
        { subject: { type: "role", id: "editor" }, name: "Editor" },
        {
          subject: {
            type: "serviceAccount",
            id: "00000000-0000-4000-8000-000000000012",
          },
          name: "Release automation",
        },
      ]),
    ),
  );
  const user = userEvent.setup();
  renderEditor();
  const chip = await screen.findByTestId("audience-chip");
  // A service account is a named recipient, not an audience.
  expect(chip).toHaveTextContent("Personal");
  await pick(user, "Release automation");
  expect(chip).toHaveTextContent("Personal");
  await pick(user, "Engineering");
  expect(chip).toHaveTextContent("Team-wide");
  // The new grant starts at Can use, the level a shared resource is for.
  expect(
    screen.getByRole("combobox", { name: "Permission for Engineering" }),
  ).toHaveTextContent("Can use");
  await pick(user, "Everyone with the Editor role");
  expect(chip).toHaveTextContent("Org-wide");
  await user.click(
    screen.getByRole("button", { name: "Remove direct access for Editor" }),
  );
  expect(chip).toHaveTextContent("Team-wide");
});

it("shows the owner row and makes another person the owner", async () => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.scrollIntoView = vi.fn();
  policy.ownerId = "owner-1";
  policy.grants = [
    {
      subject: { type: "user", id: "owner-1" },
      name: "Sam Owner",
      actions: ["read", "use", "update", "delete", "manage-permissions"],
    },
    {
      subject: { type: "user", id: "user-2" },
      name: "Alex Reader",
      actions: ["read", "use"],
    },
  ];
  let transferred: unknown;
  server.use(
    http.post(
      `${origin}/api/internal_mcp_catalog/${policy.scope}/transfer-ownership`,
      async ({ request }) => {
        transferred = await request.json();
        return HttpResponse.json({ success: true });
      },
    ),
  );
  const user = userEvent.setup();
  renderEditor();
  const owner = await screen.findByTestId("owner-grant");
  expect(owner).toHaveTextContent("Sam OwnerUserOwner");
  expect(owner).toHaveTextContent("Full access");
  // The owner keeps their grant: no level menu and no remove button.
  expect(
    screen.queryByRole("combobox", { name: "Permission for Sam Owner" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: "Remove direct access for Sam Owner",
    }),
  ).not.toBeInTheDocument();

  await user.click(
    screen.getByRole("combobox", { name: "Permission for Alex Reader" }),
  );
  await user.click(await screen.findByRole("option", { name: /Make owner/ }));
  expect(
    await screen.findByText("Make Alex Reader the owner?"),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Make owner" }));
  await waitFor(() => expect(transferred).toEqual({ ownerId: "user-2" }));
});

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  await user.click(await screen.findByRole("option", { name }));
}
