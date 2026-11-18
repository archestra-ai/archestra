import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type BulkRemoveConnection,
  BulkRemoveConnectionsDialog,
} from "./bulk-remove-connections-dialog";

vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const COPY = {
  action: "Revoke",
  verb: "Revoked",
  failureVerb: "revoke",
  noun: "credential",
  consequence: "Agents lose access until their owner connects again.",
  sharedNoun: "service account",
};

function connections(count: number): BulkRemoveConnection[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `server-${index}`,
    label: `user-${index}@example.com`,
    shared: false,
  }));
}

/**
 * DELETE /api/mcp_server/bulk removes every id it is sent, except the ones
 * refused. Returns the id list of each request it received.
 */
function serveBulkDelete(refused: Record<string, string> = {}) {
  const requests: string[][] = [];
  server.use(
    http.delete(`${API_ORIGIN}/api/mcp_server/bulk`, async ({ request }) => {
      const { ids } = (await request.json()) as { ids: string[] };
      requests.push(ids);
      return HttpResponse.json({
        succeeded: ids
          .filter((id) => !(id in refused))
          .map((id) => ({ id, name: "github" })),
        failed: ids
          .filter((id) => id in refused)
          .map((id) => ({ id, name: "github", error: refused[id] })),
      });
    }),
  );
  return requests;
}

function renderDialog(
  selection: BulkRemoveConnection[],
  onRemoved: () => void = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <BulkRemoveConnectionsDialog
      open
      onClose={vi.fn()}
      connections={selection}
      copy={COPY}
      onRemoved={onRemoved}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
}

describe("BulkRemoveConnectionsDialog", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  it("revokes a small selection in one request, without asking for the word", async () => {
    const requests = serveBulkDelete();
    const onRemoved = vi.fn();
    renderDialog(connections(3), onRemoved);

    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke 3 credentials" }),
    );

    await waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
    expect(requests).toEqual([["server-0", "server-1", "server-2"]]);
    expect(toast.success).toHaveBeenCalledWith("Revoked 3 credentials");
  });

  it("holds a large selection until the word is typed, then sends it in batches the route accepts", async () => {
    const requests = serveBulkDelete();
    const onRemoved = vi.fn();
    renderDialog(connections(1000), onRemoved);

    const confirm = screen.getByRole("button", {
      name: "Revoke 1,000 credentials",
    });
    expect(confirm).toBeDisabled();
    expect(screen.getByText("and 994 more")).toBeInTheDocument();

    const field = screen.getByLabelText(/to confirm/);
    await userEvent.type(field, "1000");
    expect(confirm).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "Revoke");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
    expect(requests.map((ids) => ids.length)).toEqual([500, 500]);
    expect(new Set(requests.flat()).size).toBe(1000);
    expect(toast.success).toHaveBeenCalledWith("Revoked 1000 credentials");
  });

  it("names the owner of a credential that could not be revoked", async () => {
    serveBulkDelete({ "server-1": "Only the connection owner can revoke" });
    const onRemoved = vi.fn();
    renderDialog(connections(3), onRemoved);

    await userEvent.click(
      screen.getByRole("button", { name: "Revoke 3 credentials" }),
    );

    await waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
    expect(toast.warning).toHaveBeenCalledWith(
      "Revoked 2 credentials — 1 credential could not be revoked",
      {
        description:
          "user-1@example.com — Only the connection owner can revoke",
      },
    );
  });

  it("warns when the selection includes shared connections", () => {
    renderDialog([
      ...connections(2),
      { id: "team-1", label: "Platform", shared: true },
    ]);

    expect(screen.getByText("Includes 1 service account")).toBeInTheDocument();
  });
});
