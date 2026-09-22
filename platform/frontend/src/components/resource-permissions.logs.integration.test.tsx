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

vi.mock("next/navigation");
const origin = "http://localhost:9000";
const endpoint = `${origin}/api/resource-permissions/:resource/:scope`;
const server = setupServer();

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => archestraApiClient.setConfig({ baseUrl: origin }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it.each([
  "log",
  "auditLog",
] as const)("lets an admin delegate %s management using only supported actions", async (resource) => {
  let submitted: unknown;
  let policy: Policy = {
    resource,
    scope: "*",
    name: "All resources",
    revision: 1,
    grants: [
      {
        subject: { type: "user", id: "log-reader" },
        name: "Log reader",
        actions: ["read"],
      },
    ],
    inheritedGrants: [],
    effectiveActions: ["read", "manage-permissions"],
  };
  server.use(
    http.get(`${endpoint}/subjects`, () => HttpResponse.json([])),
    http.get(endpoint, () => HttpResponse.json(policy)),
    http.put(endpoint, async ({ request }) => {
      submitted = await request.json();
      policy = {
        ...policy,
        revision: 2,
        grants: [
          { ...policy.grants[0], actions: ["read", "manage-permissions"] },
        ],
      };
      return HttpResponse.json(policy);
    }),
  );
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ResourcePermissions resource={resource} scope="*" />
    </QueryClientProvider>,
  );
  await user.click(
    await screen.findByRole("combobox", { name: "Permission for Log reader" }),
  );
  await user.click(screen.getByRole("option", { name: /^Full access/ }));
  await user.click(screen.getByRole("button", { name: "Save permissions" }));
  await waitFor(() =>
    expect(submitted).toEqual({
      revision: 1,
      grants: [
        {
          subject: { type: "user", id: "log-reader" },
          actions: ["read", "manage-permissions"],
        },
      ],
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save permissions" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("combobox", { name: "Permission for Log reader" }),
  ).toHaveTextContent("Full access");
});
