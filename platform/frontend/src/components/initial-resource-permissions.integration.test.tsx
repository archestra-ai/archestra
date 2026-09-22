// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { FormDialog } from "./form-dialog";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "./initial-resource-permissions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const origin = "http://localhost:9000";
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

it("adds initial access through recipient types without submitting the resource, excludes duplicates, and keeps the draft editable", async () => {
  const lookup = vi.fn(() =>
    HttpResponse.json([
      { subject: { type: "role", id: "editor" }, name: "Editor" },
      { subject: { type: "user", id: "example-user" }, name: "Alex Reader" },
    ]),
  );
  server.use(
    http.get(
      `${origin}/api/resource-permissions/agent/creation-subjects`,
      lookup,
    ),
  );
  const submit = vi.fn();
  function CreationForm() {
    const [grants, setGrants] = useState<InitialPermissionGrant[]>([]);
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(grants);
        }}
      >
        <InitialResourcePermissions
          resource="agent"
          grants={grants}
          onChange={setGrants}
        />
        <Button type="submit">Create agent</Button>
      </form>
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreationForm />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  expect(lookup).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Add access" }));
  const dialog = screen.getByRole("dialog", { name: "Add access" });
  expect(dialog).toHaveTextContent("when this resource is created");
  await user.click(within(dialog).getByRole("button", { name: /^Roles/ }));
  await user.click(within(dialog).getByRole("combobox", { name: "Add roles" }));
  await user.click(await screen.findByRole("option", { name: /Editor/ }));
  expect(within(dialog).queryByText("Alex Reader")).not.toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("combobox", { name: "Permission for Editor" }),
  );
  await user.click(screen.getByRole("option", { name: "Can edit" }));
  await user.click(within(dialog).getByRole("button", { name: "Add access" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
  expect(
    screen.getByRole("combobox", { name: "Permission for Editor" }),
  ).toHaveTextContent("Can edit");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(submit).toHaveBeenLastCalledWith([
    {
      subject: { type: "role", id: "editor" },
      name: "Editor",
      actions: ["read", "use", "update"],
    },
  ]);
  await user.click(screen.getByRole("button", { name: "Add access" }));
  await user.click(screen.getByRole("button", { name: /^Roles/ }));
  await user.click(screen.getByRole("combobox", { name: "Add roles" }));
  expect(
    await screen.findByText("No matching recipients available to add."),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "Back to recipient types" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(
    screen.getByRole("button", { name: "Remove access for Editor" }),
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(submit).toHaveBeenLastCalledWith([]);
});

it("keeps creation fields and mixed recipient permissions in one dialog until the resource is submitted", async () => {
  server.use(
    http.get(
      `${origin}/api/resource-permissions/llmVirtualKey/creation-subjects`,
      () =>
        HttpResponse.json([
          { subject: { type: "team", id: "support" }, name: "Support" },
          { subject: { type: "team", id: "design" }, name: "Design" },
        ]),
    ),
  );
  const submit = vi.fn();
  function CreationDialog() {
    const [name, setName] = useState("");
    const [grants, setGrants] = useState<InitialPermissionGrant[]>([]);
    return (
      <FormDialog
        open
        onOpenChange={() => {}}
        title="Create virtual key"
        description="Choose the key name and its initial permissions."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit({ name, grants });
          }}
        >
          <Input
            aria-label="Key name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <InitialResourcePermissions
            resource="llmVirtualKey"
            grants={grants}
            onChange={setGrants}
          />
          <Button type="submit">Create</Button>
        </form>
      </FormDialog>
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CreationDialog />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const dialog = screen.getByRole("dialog");
  await user.type(
    screen.getByRole("textbox", { name: "Key name" }),
    "Release tooling",
  );
  await user.click(screen.getByRole("button", { name: "Add access" }));
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Add access" })).toBe(dialog);
  await user.click(screen.getByRole("button", { name: /^Teams/ }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Support/ }));
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Support" }),
  );
  await user.click(screen.getByRole("option", { name: "Can edit" }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Design/ }));
  await user.click(screen.getByRole("button", { name: "Add access" }));
  expect(screen.getByRole("dialog", { name: "Create virtual key" })).toBe(
    dialog,
  );
  expect(screen.getByRole("textbox", { name: "Key name" })).toHaveValue(
    "Release tooling",
  );
  expect(screen.getByRole("button", { name: "Add access" })).toHaveFocus();
  expect(submit).not.toHaveBeenCalled();
  expect(
    screen.getByRole("combobox", { name: "Permission for Support" }),
  ).toHaveTextContent("Can edit");
  expect(
    screen.getByRole("combobox", { name: "Permission for Design" }),
  ).toHaveTextContent("Can view");
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(submit).toHaveBeenCalledWith({
    name: "Release tooling",
    grants: [
      {
        subject: { type: "team", id: "support" },
        name: "Support",
        actions: ["read", "use", "update"],
      },
      {
        subject: { type: "team", id: "design" },
        name: "Design",
        actions: ["read"],
      },
    ],
  });
});
