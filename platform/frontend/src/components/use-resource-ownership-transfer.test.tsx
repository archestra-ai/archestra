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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useResourceOwnershipTransfer } from "./use-resource-ownership-transfer";

function Harness({ onTransferred }: { onTransferred: () => void }) {
  const ownership = useResourceOwnershipTransfer({
    kind: "skill",
    resource: agent,
    onTransferred,
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>More actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>{ownership.menuItem}</DropdownMenuContent>
      </DropdownMenu>
      {ownership.dialog}
    </>
  );
}

vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");

import { within } from "@testing-library/react";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";

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
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "owner-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
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
  client.setQueryData(["skills", agent.id], agent);
  const onTransferred = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Harness onTransferred={onTransferred} />
    </QueryClientProvider>,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Transfer ownership" }));
  return { client, onTransferred, onClose };
}

it("requires a different owner, submits their ID, and invalidates cached ownership", async () => {
  const received: unknown[] = [];
  server.use(
    http.post(
      `${origin}/api/skills/${agent.id}/transfer-ownership`,
      async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ success: true });
      },
    ),
  );
  const { client, onTransferred } = show();
  const submit = within(screen.getByRole("dialog")).getByRole("button", {
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
  expect(client.getQueryState(["skills", agent.id])?.isInvalidated).toBe(true);
});

it("keeps the dialog open when the server rejects the transfer", async () => {
  server.use(
    http.post(`${origin}/api/skills/${agent.id}/transfer-ownership`, () =>
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
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Transfer ownership",
    }),
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Transfer ownership",
      }),
    ).toBeEnabled(),
  );
  expect(onTransferred).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("does not trigger the containing resource when selecting an owner", async () => {
  const openResource = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Table>
        <TableBody>
          <TableRow onClick={openResource}>
            <TableCell>
              <Harness onTransferred={vi.fn()} />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </QueryClientProvider>,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Transfer ownership" }));
  openResource.mockClear();
  const picker = screen.getByRole("combobox", { name: "New owner" });
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(picker);
  fireEvent.click(await screen.findByText("New Owner"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(openResource).not.toHaveBeenCalled();
});
