import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { TransferAgentOwnershipDialog } from "./transfer-agent-ownership-dialog";

vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
const agent = {
  id: "agent-1",
  name: "Reporting assistant",
  authorId: "owner-1",
  scope: "personal" as const,
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get(`${origin}/api/organization/members`, () =>
      HttpResponse.json([
        { id: "owner-1", name: "Current Owner", email: "owner@example.com" },
        { id: "owner-2", name: "New Owner", email: "recipient@example.com" },
      ]),
    ),
  );
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["agents", agent.id], agent);
  const onTransferred = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TransferAgentOwnershipDialog
        agent={agent}
        onClose={onClose}
        onTransferred={onTransferred}
      />
    </QueryClientProvider>,
  );
  return { client, onTransferred, onClose };
}

it("requires a different owner, submits their ID, and invalidates cached ownership", async () => {
  const received: unknown[] = [];
  server.use(
    http.post(
      `${origin}/api/agents/${agent.id}/transfer-ownership`,
      async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ success: true });
      },
    ),
  );
  const { client, onTransferred } = show();
  const submit = screen.getByRole("button", {
    name: "Transfer ownership",
  });
  expect(submit).toBeDisabled();
  expect(screen.getByText(/You may lose access/)).toBeVisible();
  const picker = screen.getByRole("combobox", { name: "New owner" });
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(picker);
  expect(screen.queryByText("Current Owner")).toBeNull();
  fireEvent.click(await screen.findByText("New Owner"));
  fireEvent.click(submit);
  await waitFor(() => expect(onTransferred).toHaveBeenCalledOnce());
  expect(received).toEqual([{ ownerId: "owner-2" }]);
  expect(client.getQueryState(["agents", agent.id])?.isInvalidated).toBe(true);
});

it("keeps the dialog open when the server rejects the transfer", async () => {
  server.use(
    http.post(`${origin}/api/agents/${agent.id}/transfer-ownership`, () =>
      HttpResponse.json(
        {
          error: {
            message: "The resource changed. Refresh and try again.",
            type: "conflict",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const { onTransferred, onClose } = show();
  const picker = screen.getByRole("combobox", { name: "New owner" });
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(picker);
  fireEvent.click(await screen.findByText("New Owner"));
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Transfer ownership" }),
    ).toBeEnabled(),
  );
  expect(onTransferred).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeVisible();
});
