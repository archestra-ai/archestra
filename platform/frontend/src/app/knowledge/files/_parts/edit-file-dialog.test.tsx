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
import { EditFileDialog } from "@/app/knowledge/files/_parts/edit-file-dialog";
import type { KnowledgeFile } from "@/lib/knowledge/knowledge-file.query";

vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");

const origin = "http://localhost:9000";
const server = setupServer();
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
  submitted = undefined;
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.patch(`${origin}/api/knowledge-files/file-1`, async ({ request }) => {
      submitted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "file-1", ...submitted });
    }),
    http.get(`${origin}/api/resource-permissions/knowledgeFile/file-1`, () =>
      HttpResponse.json({
        resource: "knowledgeFile",
        scope: "file-1",
        name: "handbook.pdf",
        revision: 1,
        grants: [
          {
            subject: { type: "team", id: "support" },
            actions: ["read"],
            name: "Support",
          },
        ],
        inheritedGrants: [],
        legacyAccess: [],
        effectiveActions: ["read", "update", "manage-permissions"],
      }),
    ),
  );
});

const file = {
  id: "file-1",
  filename: "handbook.pdf",
  directoryId: null,
  visibility: "team-scoped",
  teamIds: ["engineering"],
  labels: [],
} as unknown as KnowledgeFile;

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

it("renames a document without rewriting the sharing columns nothing reads", async () => {
  const user = userEvent.setup();
  render(
    <EditFileDialog open onOpenChange={vi.fn()} file={file} directories={[]} />,
    { wrapper },
  );

  // Access is the document's own policy now, so the recipients on screen are
  // the real ones — not the row's stale `teamIds`.
  expect(await screen.findByText("Support")).toBeVisible();
  expect(screen.queryByText("Who can see this")).not.toBeInTheDocument();

  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "employee-handbook.pdf");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(submitted).toMatchObject({ filename: "employee-handbook.pdf" }),
  );
  expect(submitted).not.toHaveProperty("visibility");
  expect(submitted).not.toHaveProperty("teamIds");
});
