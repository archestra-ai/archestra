// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
type Kind = "oauthClient";
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
        name: "OAuth reviewers",
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
    oauthClient: makePolicy("oauthClient"),
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
it("saves one unified policy without adding actions", async () => {
  const user = renderEntry();
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Remove direct access for OAuth reviewers",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save permissions" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    resource: "oauthClient",
    body: {
      revision: 1,
      grants: [
        {
          subject: { type: "role", id: "admin" },
          actions: ["read", "update", "delete", "manage-permissions"],
        },
      ],
    },
  });
  expect(screen.queryByText("MCP clients")).not.toBeInTheDocument();
  expect(screen.queryByText("LLM clients")).not.toBeInTheDocument();
});
it("keeps global permissions read-only for a policy reader", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permission) =>
      ({
        data: permission.accessPolicies?.includes("read") ?? false,
      }) as ReturnType<typeof useHasPermissions>,
  );
  const user = renderEntry();
  await user.click(screen.getByRole("button", { name: "Permissions" }));
  expect(await screen.findByText("OAuth reviewers")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Save permissions" }),
  ).not.toBeInTheDocument();
  expect(writes).toHaveLength(0);
});
it.each([
  "mcp",
  "llm",
])("opens the unified policy for a legacy %s deep link", async (kind) => {
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
  expect(await screen.findByText("OAuth reviewers")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(replace).toHaveBeenCalledWith(
    "/settings/oauth-clients?search=example",
    { scroll: false },
  );
});
