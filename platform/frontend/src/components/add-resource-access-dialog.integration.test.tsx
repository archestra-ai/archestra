// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { type ComponentProps, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { AddResourceAccessDialog } from "./add-resource-access-dialog";

const origin = "http://localhost:9000";
const endpoint = `${origin}/api/resource-permissions/:resource/:scope/subjects`;
const server = setupServer();
const choices = [
  { subject: { type: "user", id: "member-existing" }, name: "Existing member" },
  {
    subject: { type: "user", id: "member-selected" },
    name: "Alex Reader",
    email: "alex@example.com",
  },
  { subject: { type: "team", id: "team-example" }, name: "Engineering team" },
  { subject: { type: "role", id: "editor" }, name: "Editor" },
  {
    subject: {
      type: "serviceAccount",
      id: "00000000-0000-4000-8000-000000000011",
    },
    name: "Release automation",
  },
  {
    subject: { type: "organization", id: "*" },
    name: "Everyone in the organization",
  },
];

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

it("loads the chosen recipient type, excludes existing grants, searches, and adds the selected permission to the page draft", async () => {
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
  const onAdd = vi.fn();
  renderDialog({ onAdd });
  const user = userEvent.setup();
  expect(queries).toEqual([]);
  await user.click(screen.getByRole("button", { name: /^People/ }));
  await user.click(screen.getByRole("combobox", { name: "Add people" }));
  expect(
    await screen.findByRole("option", { name: /Alex Reader/ }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Existing member")).not.toBeInTheDocument();
  expect(screen.queryByText("Engineering team")).not.toBeInTheDocument();
  expect(screen.queryByText("Release automation")).not.toBeInTheDocument();
  await user.type(
    screen.getByPlaceholderText("Search by name or email…"),
    "alex@example.com",
  );
  await waitFor(() => expect(queries).toContain("alex@example.com"));
  await user.click(await screen.findByRole("option", { name: /Alex Reader/ }));
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Alex Reader" }),
  );
  await user.click(screen.getByRole("option", { name: "Can use" }));
  await user.click(screen.getByRole("button", { name: "Add access" }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([
    {
      subject: { type: "user", id: "member-selected" },
      name: "Alex Reader",
      email: "alex@example.com",
      actions: ["read", "use"],
    },
  ]);
  expect(
    screen.queryByRole("dialog", { name: "Add access" }),
  ).not.toBeInTheDocument();
});

it("keeps selected recipients when going back and guards dismissing the dialog", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json(choices)));
  renderDialog();
  const user = userEvent.setup();
  expect(
    screen.getByRole("button", { name: /^Service accounts/ }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Teams/ }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  await user.click(
    await screen.findByRole("option", { name: /Engineering team/ }),
  );
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  expect(
    screen.getByRole("button", {
      name: "Remove Engineering team from selection",
    }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  await user.click(screen.getByRole("button", { name: /^Teams/ }));
  expect(
    screen.getByRole("combobox", { name: "Permission for Engineering team" }),
  ).toHaveTextContent("Can view");
});

it("retries a failed recipient lookup without treating it as an empty list", async () => {
  server.use(http.get(endpoint, () => new HttpResponse(null, { status: 503 })));
  renderDialog();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Roles/ }));
  expect(
    await screen.findByText("Could not load recipients"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("No recipients available to add."),
  ).not.toBeInTheDocument();
  server.use(http.get(endpoint, () => HttpResponse.json(choices)));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await user.click(await screen.findByRole("combobox", { name: "Add roles" }));
  expect(
    await screen.findByRole("option", { name: /Editor/ }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Alex Reader")).not.toBeInTheDocument();
});

it("choosing the organization goes straight to permission selection and adds only that audience", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json(choices)));
  const onAdd = vi.fn();
  renderDialog({ onAdd });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^People/ }));
  await user.click(screen.getByRole("combobox", { name: "Add people" }));
  await user.click(await screen.findByRole("option", { name: /Alex Reader/ }));
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Everyone in the organization" }),
  );
  expect(screen.getAllByText("Everyone in the organization")).toHaveLength(1);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  expect(screen.queryByText("Alex Reader")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  await user.click(screen.getByRole("button", { name: /^People/ }));
  expect(
    screen.getByRole("combobox", { name: "Permission for Alex Reader" }),
  ).toHaveTextContent("Can view");
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Everyone in the organization" }),
  );
  await user.click(screen.getByRole("radio", { name: /^Can use/ }));
  await user.click(screen.getByRole("button", { name: "Add access" }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([
    {
      subject: { type: "organization", id: "*" },
      name: "Everyone in the organization",
      actions: ["read", "use"],
    },
  ]);
});

it("does not allow organization access when the audience lookup fails or is unavailable", async () => {
  server.use(http.get(endpoint, () => new HttpResponse(null, { status: 503 })));
  renderDialog();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Everyone in the organization" }),
  );
  expect(
    await screen.findByText("Could not load recipients"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add access" })).toBeDisabled();
  server.use(http.get(endpoint, () => HttpResponse.json([])));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("No recipients available to add."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add access" })).toBeDisabled();
});

it("keeps separate permissions for multiple teams and a service account across searches and back navigation", async () => {
  const teams = [
    { subject: { type: "team", id: "builders" }, name: "Builders" },
    { subject: { type: "team", id: "reviewers" }, name: "Reviewers" },
    {
      subject: { type: "serviceAccount", id: "automation" },
      name: "Release automation",
    },
  ];
  server.use(
    http.get(endpoint, ({ request }) => {
      const query = new URL(request.url).searchParams.get("query") ?? "";
      return HttpResponse.json(
        teams.filter((team) =>
          team.name.toLowerCase().includes(query.toLowerCase()),
        ),
      );
    }),
  );
  const onAdd = vi.fn();
  renderDialog({ onAdd });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Teams/ }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Builders/ }));
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Builders" }),
  );
  await user.click(screen.getByRole("option", { name: "Can edit" }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  expect(
    screen.queryByRole("option", { name: /Builders/ }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByPlaceholderText("Search teams…"), "Reviewers");
  await user.click(await screen.findByRole("option", { name: /Reviewers/ }));
  expect(
    screen.getByRole("combobox", { name: "Permission for Builders" }),
  ).toHaveTextContent("Can edit");
  expect(
    screen.getByRole("combobox", { name: "Permission for Reviewers" }),
  ).toHaveTextContent("Can view");
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  await user.click(screen.getByRole("button", { name: /^Service accounts/ }));
  await user.click(
    screen.getByRole("combobox", { name: "Add service accounts" }),
  );
  await user.click(
    await screen.findByRole("option", { name: /Release automation/ }),
  );
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Release automation" }),
  );
  await user.click(screen.getByRole("option", { name: "Can use" }));
  await user.click(
    screen.getByRole("button", { name: "Remove Reviewers from selection" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  await user.click(screen.getByRole("button", { name: /^Teams/ }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Reviewers/ }));
  await user.click(screen.getByRole("button", { name: "Add access" }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([
    { ...teams[0], actions: ["read", "use", "update"] },
    { ...teams[2], actions: ["read", "use"] },
    { ...teams[1], actions: ["read"] },
  ]);
});

function renderDialog(
  overrides: Partial<ComponentProps<typeof AddResourceAccessDialog>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <AddResourceAccessDialog
        open={open}
        onOpenChange={setOpen}
        resource="agent"
        scope="*"
        existingSubjects={[{ type: "user", id: "member-existing" }]}
        presets={[
          {
            value: "view",
            label: "Can view",
            description: "Read this resource",
            actions: ["read"],
            disabled: false,
          },
          {
            value: "edit",
            label: "Can edit",
            description: "Read, use and edit this resource",
            actions: ["read", "use", "update"],
            disabled: false,
          },
          {
            value: "use",
            label: "Can use",
            description: "Read and use this resource",
            actions: ["read", "use"],
            disabled: false,
          },
        ]}
        onAdd={vi.fn()}
        {...overrides}
      />
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}
