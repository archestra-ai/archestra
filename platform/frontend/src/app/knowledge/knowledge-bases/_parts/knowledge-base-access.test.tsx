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
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { CreateKnowledgeBaseDialog } from "./create-knowledge-base-dialog";
import { EditKnowledgeBaseDialog } from "./edit-knowledge-base-dialog";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/clients/auth/auth-client");
vi.mock("sonner");
const server = setupServer();
const origin = "http://localhost:9000";
let submitted: Record<string, unknown> | undefined;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  submitted = undefined;
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
  server.use(
    http.get(`${origin}/api/teams`, () =>
      HttpResponse.json({
        data: [
          { id: "engineering", name: "Engineering", parentId: null },
          { id: "support", name: "Support", parentId: null },
        ],
        pagination: { total: 2 },
      }),
    ),
    http.get(
      `${origin}/api/resource-permissions/knowledgeBase/creation-subjects`,
      () =>
        HttpResponse.json([
          { subject: { type: "team", id: "engineering" }, name: "Engineering" },
          { subject: { type: "team", id: "support" }, name: "Support" },
        ]),
    ),
    http.post(`${origin}/api/knowledge-bases`, async ({ request }) => {
      submitted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "kb-1", ...submitted });
    }),
    http.put(`${origin}/api/knowledge-bases/kb-1`, async ({ request }) => {
      submitted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "kb-1", ...submitted });
    }),
  );
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

it("creates a knowledge base with different permissions for selected teams", async () => {
  const user = userEvent.setup();
  render(<CreateKnowledgeBaseDialog open onOpenChange={vi.fn()} />, {
    wrapper,
  });
  await user.type(screen.getByLabelText("Name"), "Shared handbook");
  await user.click(screen.getByRole("button", { name: "Add access" }));
  await user.click(screen.getByRole("button", { name: /Teams/ }));
  await user.click(await screen.findByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Engineering/ }));
  await user.click(await screen.findByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Support/ }));
  await user.click(
    screen.getByRole("combobox", { name: "Permission for Engineering" }),
  );
  await user.click(screen.getByRole("option", { name: "Can edit" }));
  await user.click(screen.getByRole("button", { name: "Add access" }));
  await user.click(
    screen.getByRole("button", { name: "Create Knowledge Base" }),
  );
  await waitFor(() =>
    expect(submitted).toMatchObject({
      name: "Shared handbook",
      visibility: "private",
      initialGrants: [
        {
          subject: { type: "team", id: "engineering" },
          actions: ["read", "use", "update"],
        },
        { subject: { type: "team", id: "support" }, actions: ["read"] },
      ],
    }),
  );
});

it("edits access through the knowledge base's own policy, not its sharing columns", async () => {
  const user = userEvent.setup();
  server.use(
    http.get(`${origin}/api/resource-permissions/knowledgeBase/kb-1`, () =>
      HttpResponse.json({
        resource: "knowledgeBase",
        scope: "kb-1",
        name: "Handbook",
        revision: 3,
        grants: [
          {
            subject: { type: "team", id: "engineering" },
            actions: ["read", "use"],
            name: "Engineering",
          },
        ],
        inheritedGrants: [],
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

  render(
    <EditKnowledgeBaseDialog
      open
      onOpenChange={vi.fn()}
      knowledgeBase={{ id: "kb-1", name: "Handbook", description: null }}
    />,
    { wrapper },
  );

  // Who can reach this knowledge base comes from the policy, so the reader
  // sees the real recipients rather than a stale visibility enum.
  expect(await screen.findByText("Engineering")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Teams Share/ }),
  ).not.toBeInTheDocument();

  // Saving the rest of the form must not send sharing columns nothing reads —
  // that is what made the old control look like it changed access.
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Company handbook");
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() =>
    expect(submitted).toMatchObject({ name: "Company handbook" }),
  );
  expect(submitted).not.toHaveProperty("visibility");
  expect(submitted).not.toHaveProperty("teamIds");
});

it("creates a personal knowledge base without requiring a team", async () => {
  const user = userEvent.setup();
  render(<CreateKnowledgeBaseDialog open onOpenChange={vi.fn()} />, {
    wrapper,
  });
  await user.type(screen.getByLabelText("Name"), "Research notes");
  await user.click(
    screen.getByRole("button", { name: "Create Knowledge Base" }),
  );
  await waitFor(() =>
    expect(submitted).toMatchObject({
      name: "Research notes",
      visibility: "private",
      initialGrants: [],
    }),
  );
});
