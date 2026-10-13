// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient, type PermissionSubject } from "@archestra/shared";
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
import { ResourceAccessAddField } from "./resource-access-add-field";

const origin = "http://localhost:9000";
const endpoint = `${origin}/api/resource-permissions/:resource/:scope/subjects`;
const server = setupServer();
// Deliberately out of display order, so the grouping is the component's.
const choices = [
  {
    subject: {
      type: "serviceAccount",
      id: "00000000-0000-4000-8000-000000000011",
    },
    name: "Release automation",
  },
  {
    subject: { type: "user", id: "member-selected" },
    name: "Alex Reader",
    email: "alex@example.com",
  },
  { subject: { type: "user", id: "member-existing" }, name: "Existing member" },
  { subject: { type: "team", id: "team-example" }, name: "Engineering team" },
  { subject: { type: "role", id: "editor" }, name: "Editor" },
  {
    subject: { type: "organization", id: "*" },
    name: "Everyone in the organization",
  },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => archestraApiClient.setConfig({ baseUrl: origin }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("groups recipients in a fixed order and leaves out existing grants", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json(choices)));
  renderField({
    existingSubjects: [{ type: "user", id: "member-existing" }],
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  await screen.findByRole("option", { name: "Alex Reader" });
  const groups = screen.getAllByRole("group");
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
    "Organization",
    "Teams",
    "People",
    "Service accounts",
  ]);
  // Everyone comes first, then each role as an audience of its own.
  expect(
    within(groups[0])
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label")),
  ).toEqual(["Everyone in the organization", "Everyone with the Editor role"]);
  expect(
    within(groups[2])
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label")),
  ).toEqual(["Alex Reader"]);
  expect(
    screen.queryByRole("option", { name: "Existing member" }),
  ).not.toBeInTheDocument();
});

it("searches on the server and picks a recipient in one step", async () => {
  const queries: string[] = [];
  server.use(
    http.get(endpoint, ({ request }) => {
      const query = new URL(request.url).searchParams.get("query") ?? "";
      queries.push(query);
      return HttpResponse.json(
        choices.filter((choice) =>
          `${choice.name} ${"email" in choice ? choice.email : ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
      );
    }),
  );
  const onPick = renderField();
  const user = userEvent.setup();
  // Nothing is looked up until the field opens.
  expect(queries).toEqual([]);
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  await screen.findByRole("option", { name: "Engineering team" });
  await user.type(
    screen.getByRole("combobox", { name: "Search recipients" }),
    "alex@example.com",
  );
  await waitFor(() => expect(queries).toContain("alex@example.com"));
  expect(
    await screen.findByRole("option", { name: "Alex Reader" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Engineering team" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Alex Reader" }));
  expect(onPick).toHaveBeenCalledExactlyOnceWith({
    subject: { type: "user", id: "member-selected" },
    name: "Alex Reader",
    email: "alex@example.com",
  });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("offers everyone in the organization until it has a grant", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json(choices)));
  const onPick = renderField();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  await user.click(
    await screen.findByRole("option", { name: "Everyone in the organization" }),
  );
  expect(onPick).toHaveBeenCalledWith({
    subject: { type: "organization", id: "*" },
    name: "Everyone in the organization",
  });
});

it("shows a retryable error when recipients cannot load", async () => {
  let fail = true;
  server.use(
    http.get(endpoint, () =>
      fail
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json(choices),
    ),
  );
  renderField();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  expect(
    await screen.findByText("Could not load recipients"),
  ).toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("option", { name: "Alex Reader" }),
  ).toBeInTheDocument();
});

it("says so when every recipient already has access", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json([
        { subject: { type: "team", id: "team-example" }, name: "Engineering" },
      ]),
    ),
  );
  renderField({ existingSubjects: [{ type: "team", id: "team-example" }] });
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  expect(
    await screen.findByText("No recipients available to add."),
  ).toBeInTheDocument();
});

function renderField({
  existingSubjects = [],
}: {
  existingSubjects?: PermissionSubject[];
} = {}) {
  const onPick = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ResourceAccessAddField
        resource="agent"
        scope="00000000-0000-4000-8000-000000000010"
        existingSubjects={existingSubjects}
        onPick={onPick}
      />
    </QueryClientProvider>,
  );
  return onPick;
}
