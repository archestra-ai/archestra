// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient, TEAM_RESOURCE_SCOPE } from "@archestra/shared";
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
  { subject: { type: "user", id: "member-selected" }, name: "Alex Reader" },
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
          choice.name.toLowerCase().includes(query.toLowerCase()),
        ),
      );
    }),
  );
  const onAdd = vi.fn();
  renderDialog({ onAdd });
  const user = userEvent.setup();
  expect(queries).toEqual([]);
  await user.click(screen.getByRole("button", { name: /^People/ }));
  expect(
    await screen.findByRole("checkbox", { name: "Alex Reader" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Existing member")).not.toBeInTheDocument();
  expect(screen.queryByText("Engineering team")).not.toBeInTheDocument();
  expect(screen.queryByText("Release automation")).not.toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Search people" }),
    "Alex",
  );
  await waitFor(() => expect(queries).toContain("Alex"));
  await user.click(
    await screen.findByRole("checkbox", { name: "Alex Reader" }),
  );
  await user.click(screen.getByRole("radio", { name: /^Can use/ }));
  await user.click(screen.getByRole("button", { name: "Add access" }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith([
    {
      subject: { type: "user", id: "member-selected" },
      name: "Alex Reader",
      actions: ["read", "use"],
    },
  ]);
  expect(
    screen.queryByRole("dialog", { name: "Add access" }),
  ).not.toBeInTheDocument();
});

it("keeps selected recipients when going back and guards dismissing the dialog", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json(choices)));
  renderDialog({ scope: TEAM_RESOURCE_SCOPE });
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: /^Service accounts/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Teams/ }));
  await user.click(
    await screen.findByRole("checkbox", { name: "Engineering team" }),
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
    await screen.findByRole("checkbox", { name: "Engineering team" }),
  ).toBeChecked();
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
  expect(
    await screen.findByRole("checkbox", { name: "Editor" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Alex Reader")).not.toBeInTheDocument();
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
