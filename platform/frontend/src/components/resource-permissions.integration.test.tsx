// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
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
    legacyAccess: [],
    effectiveActions: ["read", "use", "update", "delete", "manage-permissions"],
  };
  server.use(
    http.get(endpoint, () => HttpResponse.json(policy)),
    http.get(`${endpoint}/subjects`, () => HttpResponse.json([])),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderEditor(onParentSubmit?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const editor = (
    <ResourcePermissions
      resource="mcpRegistry"
      scope={policy.scope}
      embedded={!!onParentSubmit}
    />
  );
  return render(
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
}

it("explains separate wildcard and team-relative inheritance for the same recipient", async () => {
  policy.inheritedGrants = [
    {
      subject: { type: "role", id: "editor" },
      name: "Editor",
      actions: ["read"],
      sourceScope: "*",
    },
    {
      subject: { type: "role", id: "editor" },
      name: "Editor",
      actions: ["update"],
      sourceScope: "teams:*",
    },
  ];
  renderEditor();
  expect(
    await screen.findByText(/All resources of this type/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Resources shared with the recipient’s teams/),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Editor")).toHaveLength(2);
  await userEvent
    .setup()
    .click(screen.getByRole("checkbox", { name: "Show inherited grants" }));
  expect(screen.queryByText("Editor")).not.toBeInTheDocument();
});

it("revokes a service account's direct grant without removing inherited team access", async () => {
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
  await user.click(screen.getByRole("button", { name: "Save permissions" }));
  await waitFor(() => expect(submitted).toEqual({ revision: 1, grants: [] }));
  expect(screen.getByText("Engineering")).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save permissions" }),
    ).toBeDisabled(),
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
  await user.click(screen.getByRole("button", { name: "Save permissions" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Updated automation")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save permissions" }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Discard draft and reload" }),
  );
  expect(screen.getByText("Updated automation")).toBeInTheDocument();
});

it("lets readers inspect grants without offering mutations", async () => {
  policy.effectiveActions = ["read"];
  renderEditor();
  await screen.findByText("Build automation");
  expect(
    screen.getByRole("combobox", { name: "Permission for Build automation" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save permissions" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Add permission recipient" }),
  ).not.toBeInTheDocument();
});
