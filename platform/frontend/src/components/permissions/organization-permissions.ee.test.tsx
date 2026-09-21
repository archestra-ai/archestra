// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
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
  it,
  vi,
} from "vitest";
import { OrganizationPermissions } from "./organization-permissions.ee";

vi.mock("next/navigation");
const origin = "http://localhost:9000";
const server = setupServer(
  http.get(`${origin}/api/resource-permissions/:resource/:scope/subjects`, () =>
    HttpResponse.json([]),
  ),
  http.get(
    `${origin}/api/resource-permissions/:resource/:scope`,
    ({ params }) =>
      HttpResponse.json({
        resource: params.resource,
        scope: params.scope,
        name: "All resources",
        revision: 1,
        grants: [
          {
            subject: { type: "role", id: "admin" },
            name: "Admin",
            actions: ["read", "use", "update", "delete", "manage-permissions"],
          },
        ],
        inheritedGrants: [],
        legacyAccess: [],
        effectiveActions: [
          "read",
          "use",
          "update",
          "delete",
          "manage-permissions",
        ],
      }),
  ),
);
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
  "All agents",
  "Agents shared with their teams",
])("protects the draft in %s when changing resource", async (sectionName) => {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OrganizationPermissions />
    </QueryClientProvider>,
  );
  const section = within(screen.getByRole("region", { name: sectionName }));
  await user.click(
    await section.findByRole("button", {
      name: "Remove direct access for Admin",
    }),
  );
  await user.click(screen.getByRole("combobox", { name: "Resource type" }));
  await user.click(screen.getByRole("option", { name: "Skills" }));
  expect(
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    section.getByRole("button", { name: "Save permissions" }),
  ).toBeEnabled();
  expect(
    section.queryByRole("button", { name: "Remove direct access for Admin" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Resource type" }));
  await user.click(screen.getByRole("option", { name: "Skills" }));
  await user.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(
    await screen.findByRole("region", { name: "All skills" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save permissions" }),
  ).not.toBeInTheDocument();
});
