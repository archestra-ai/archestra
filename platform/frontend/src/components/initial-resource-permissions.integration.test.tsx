// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

vi.mock("@/lib/auth/auth.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/auth.query")>()),
  useSession: () => ({
    data: {
      user: { id: "author-user", name: "Sam Author", email: "sam@example.com" },
    },
  }),
}));

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

it("adds initial access without submitting the resource, excludes duplicates, and keeps the draft editable", async () => {
  const lookup = vi.fn(() =>
    HttpResponse.json([
      { subject: { type: "role", id: "editor" }, name: "Editor" },
      { subject: { type: "user", id: "example-user" }, name: "Alex Reader" },
      { subject: { type: "user", id: "author-user" }, name: "Sam Author" },
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
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CreationForm />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  // The author gets Full access on create, so the form lists them first.
  expect(screen.getByTestId("author-grant")).toHaveTextContent(
    "Sam AuthorUserYouFull access",
  );
  // Recipients load when the field opens, not with the form.
  expect(lookup).not.toHaveBeenCalled();
  await pick(user, "Everyone with the Editor role");
  expect(submit).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Editor" }),
  );
  await user.click(screen.getByRole("option", { name: "Can edit" }));
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(submit).toHaveBeenLastCalledWith([
    {
      subject: { type: "role", id: "editor" },
      name: "Editor",
      actions: ["read", "use", "update"],
    },
  ]);
  // A recipient with a grant is no longer offered.
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  expect(
    await screen.findByRole("option", { name: "Alex Reader" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Everyone with the Editor role" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Sam Author" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "Remove access for Editor" }),
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(submit).toHaveBeenLastCalledWith([]);
});

it("moves the audience chip with the draft grants", async () => {
  server.use(
    http.get(`${origin}/api/resource-permissions/agent/creation-subjects`, () =>
      HttpResponse.json([
        { subject: { type: "team", id: "support" }, name: "Support" },
        {
          subject: { type: "organization", id: "*" },
          name: "Everyone in the organization",
        },
        {
          subject: {
            type: "serviceAccount",
            id: "00000000-0000-4000-8000-000000000011",
          },
          name: "Release automation",
        },
      ]),
    ),
  );
  function CreationForm() {
    const [grants, setGrants] = useState<InitialPermissionGrant[]>([]);
    return (
      <InitialResourcePermissions
        resource="agent"
        grants={grants}
        onChange={setGrants}
      />
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CreationForm />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const chip = screen.getByTestId("audience-chip");
  expect(chip).toHaveTextContent("Personal");
  await pick(user, "Release automation");
  expect(chip).toHaveTextContent("Personal");
  await pick(user, "Support");
  expect(chip).toHaveTextContent("Team-wide");
  await pick(user, "Everyone in the organization");
  expect(chip).toHaveTextContent("Org-wide");
  await user.click(
    screen.getByRole("button", {
      name: "Remove access for Everyone in the organization",
    }),
  );
  expect(chip).toHaveTextContent("Team-wide");
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
  await pick(user, "Support");
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Support" }),
  );
  await user.click(screen.getByRole("option", { name: "Can edit" }));
  await pick(user, "Design");
  expect(screen.getByRole("dialog", { name: "Create virtual key" })).toBe(
    dialog,
  );
  expect(screen.getByRole("textbox", { name: "Key name" })).toHaveValue(
    "Release tooling",
  );
  expect(submit).not.toHaveBeenCalled();
  expect(
    screen.getByRole("combobox", { name: "Permission for Support" }),
  ).toHaveTextContent("Can edit");
  expect(
    screen.getByRole("combobox", { name: "Permission for Design" }),
  ).toHaveTextContent("Can use");
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
        actions: ["read", "use"],
      },
    ],
  });
});

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Add access" }));
  await user.click(await screen.findByRole("option", { name }));
}
