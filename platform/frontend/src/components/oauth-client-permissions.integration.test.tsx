// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { ResourcePermissions as Policy } from "@/lib/resource-permissions.query";
import { OAuthClientPermissions } from "./oauth-client-permissions";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

const origin = "http://localhost:9000";
type Kind = "mcpOauthClient" | "llmOauthClient";
let policies: Record<Kind, Policy>;
let writes: {
  resource: string;
  body: { revision: number; grants: Policy["grants"] };
}[];
const server = setupServer(
  http.get(
    `${origin}/api/resource-permissions/:resource/:scope`,
    ({ params }) => HttpResponse.json(policies[params.resource as Kind]),
  ),
  http.get(`${origin}/api/resource-permissions/:resource/:scope/subjects`, () =>
    HttpResponse.json([]),
  ),
  http.put(
    `${origin}/api/resource-permissions/:resource/:scope`,
    async ({ params, request }) => {
      const resource = params.resource as Kind;
      const body = (await request.json()) as {
        revision: number;
        grants: Policy["grants"];
      };
      writes.push({ resource, body });
      policies[resource] = {
        ...policies[resource],
        grants: body.grants.map((grant) => ({
          ...grant,
          name:
            policies[resource].grants.find(
              (previous) =>
                previous.subject.type === grant.subject.type &&
                previous.subject.id === grant.subject.id,
            )?.name ?? "Recipient",
        })),
        revision: body.revision + 1,
      };
      return HttpResponse.json(policies[resource]);
    },
  ),
);
function makePolicy(resource: Kind): Policy {
  return {
    resource,
    scope: "*",
    name: "Client registrations",
    ownerId: null,
    revision: 1,
    grants: [
      {
        subject: { type: "role", id: "admin" },
        name: "Admin",
        actions: ["read", "update", "delete", "manage-permissions"],
      },
      {
        subject: { type: "team", id: "reviewers" },
        name: resource === "mcpOauthClient" ? "MCP reviewers" : "LLM reviewers",
        actions: ["read"],
      },
    ],
    inheritedGrants: [],
    effectiveActions: ["read", "update", "delete", "manage-permissions"],
    actorSubjects: [{ type: "role", id: "admin" }],
  };
}
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
beforeEach(() => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/settings/oauth-clients");
  vi.mocked(useAppName).mockReturnValue("Example");
  policies = {
    mcpOauthClient: makePolicy("mcpOauthClient"),
    llmOauthClient: makePolicy("llmOauthClient"),
  };
  writes = [];
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "admin-user" } },
  } as ReturnType<typeof useSession>);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function renderEntry() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OAuthClientPermissions />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
async function switchTo(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const dialog = screen.getByRole("dialog", {
    name: "OAuth client permissions",
  });
  await user.click(within(dialog).getAllByRole("link", { name })[0]);
}
it("saves only the selected client policy and retains the other policy", async () => {
  const user = renderEntry();
  expect(screen.getAllByRole("button", { name: "Permissions" })).toHaveLength(
    1,
  );
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for MCP reviewers",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save permissions" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    resource: "mcpOauthClient",
    body: { revision: 1, grants: [{ subject: { type: "role", id: "admin" } }] },
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save permissions" }),
    ).not.toBeInTheDocument(),
  );
  await switchTo(user, "LLM clients");
  expect(await screen.findByText("LLM reviewers")).toBeVisible();
  expect(policies.llmOauthClient.revision).toBe(1);
  await switchTo(user, "MCP clients");
  await screen.findByText("Admin");
  expect(screen.queryByText("MCP reviewers")).not.toBeInTheDocument();
});
it("keeps a dirty draft when switching is cancelled and discards it only after confirmation", async () => {
  const user = renderEntry();
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for MCP reviewers",
    }),
  );
  await switchTo(user, "LLM clients");
  expect(
    screen.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByText(
      "Manage access to all MCP OAuth clients, including future clients.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("MCP reviewers")).not.toBeInTheDocument();
  await switchTo(user, "LLM clients");
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(await screen.findByText("LLM reviewers")).toBeVisible();
  await switchTo(user, "MCP clients");
  expect(await screen.findByText("MCP reviewers")).toBeVisible();
  expect(writes).toHaveLength(0);
});
it("guards closing a dirty dialog", async () => {
  const user = renderEntry();
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for MCP reviewers",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("dialog", { name: "OAuth client permissions" }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});
it("lets viewers inspect both policies without allowing edits", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({ data: !permissions.accessPolicies?.includes("update") }) as ReturnType<
        typeof useHasPermissions
      >,
  );
  const user = renderEntry();
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  expect(await screen.findByText("MCP reviewers")).toBeVisible();
  for (const button of screen.getAllByRole("button", {
    name: /Remove direct access/,
  }))
    expect(button).toBeDisabled();
  expect(
    screen.queryByRole("combobox", { name: "Add access" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save permissions" }),
  ).not.toBeInTheDocument();
  await switchTo(user, "LLM clients");
  expect(await screen.findByText("LLM reviewers")).toBeVisible();
  expect(writes).toHaveLength(0);
});

it.each([
  "mcp",
  "llm",
] as const)("opens the linked %s policy directly and removes dialog parameters on close", async (kind) => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      `permissions=all&permissionResource=${kind}OauthClient&search=example`,
    ) as ReturnType<typeof useSearchParams>,
  );
  const replace = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ replace } as unknown as ReturnType<
    typeof useRouter
  >);
  const user = renderEntry();
  const dialog = await screen.findByRole("dialog", {
    name: "OAuth client permissions",
  });
  expect(
    await within(dialog).findByText(`${kind.toUpperCase()} reviewers`),
  ).toBeVisible();
  const other = kind === "mcp" ? "LLM" : "MCP";
  expect(
    within(dialog).queryByText(`${other} reviewers`),
  ).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(replace).toHaveBeenCalledWith(
    "/settings/oauth-clients?search=example",
    { scroll: false },
  );
  expect(writes).toHaveLength(0);
});
