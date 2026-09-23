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

it("explains organization-wide access without making inherited permissions editable", async () => {
  policy.inheritedGrants = [
    {
      subject: { type: "role", id: "editor" },
      name: "Editor",
      actions: ["read"],
      sourceScope: "*",
    },
  ];
  const user = userEvent.setup();
  renderEditor();
  const allSource = await screen.findByRole("button", {
    name: "Why Editor has access: Every MCP registry entry",
  });
  await user.click(allSource);
  expect(
    await screen.findByRole("dialog", { name: "Access source for Editor" }),
  ).toHaveTextContent("every MCP registry entry, including new ones");
  expect(
    screen.getByRole("button", {
      name: "permissions for all MCP registry entries",
    }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(allSource).toHaveFocus();
  allSource.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Access source for Editor" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getAllByText("Editor")).toHaveLength(1);
  // Inherited access is not editable here: it has no picker and no remove
  // button, which is what "change it at its source" means in the markup.
  expect(
    screen.queryByRole("combobox", { name: "Permission for Editor" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Remove direct access for Editor/ }),
  ).not.toBeInTheDocument();
});

it("opens the shared all-resource editor from an inherited permission source", async () => {
  server.use(
    http.get(
      `${origin}/api/resource-permissions/mcpRegistry/:scope`,
      ({ request }) => {
        if (!decodeURIComponent(new URL(request.url).pathname).endsWith("/*"))
          return HttpResponse.json(policy);
        return HttpResponse.json({
          ...policy,
          scope: "*",
          inheritedGrants: [],
          grants: [
            {
              subject: { type: "role", id: "editor" },
              name: "Editor",
              actions: ["read"],
            },
          ],
        });
      },
    ),
  );
  renderEditor();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "Why Engineering has access: Every MCP registry entry",
    }),
  );
  await user.click(
    screen.getByRole("button", {
      name: "permissions for all MCP registry entries",
    }),
  );
  expect(
    await screen.findByRole("dialog", {
      name: "Permissions for all MCP registry entries",
    }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("combobox", { name: "Permission for Editor" }),
  ).toBeEnabled();
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
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(submitted).toEqual({ revision: 1, grants: [] }));
  // The team grant is inherited, so revoking the direct one leaves it standing.
  expect(screen.getByText("Engineering")).toBeInTheDocument();
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

it("lets readers inspect grants without offering mutations", async () => {
  policy.effectiveActions = ["read"];
  renderEditor();
  await screen.findByText("Build automation");
  expect(
    screen.getByRole("combobox", { name: "Permission for Build automation" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Add access" }),
  ).not.toBeInTheDocument();
});
