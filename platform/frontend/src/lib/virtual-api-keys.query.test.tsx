import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { authQueryKeys } from "@/lib/auth/auth.query";
import {
  useAllVirtualApiKeys,
  useCreateVirtualApiKey,
  useUpdateVirtualApiKey,
} from "./virtual-api-keys.query";

vi.mock("sonner");

const API = "http://localhost:9000";
const KEY_ID = "11111111-2222-4333-8444-555555555555";
const TEAM_ID = "22222222-3333-4444-8555-666666666666";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function MemberKeys({ onEdit }: { onEdit: () => void }) {
  const keys = useAllVirtualApiKeys();
  const create = useCreateVirtualApiKey();
  const update = useUpdateVirtualApiKey();
  return (
    <>
      <Button
        onClick={() =>
          create.mutate({
            data: {
              name: "Member key",
              keyType: "passthrough",
              ownerId: "member",
              billingTeamId: TEAM_ID,
            },
          })
        }
      >
        Create member key
      </Button>
      <Button
        onClick={() =>
          update.mutate({
            id: KEY_ID,
            data: {
              name: "Member key",
              keyType: "passthrough",
              billingTeamId: TEAM_ID,
            },
          })
        }
      >
        Change billing team
      </Button>
      {keys.data?.data.map((key) => (
        <TableRowActions
          key={key.id}
          permissionScope={key.id}
          itemName={key.name}
          actions={[
            {
              label: "Edit",
              icon: null,
              permissions: { llmVirtualKey: ["update"] },
              onClick: onEdit,
            },
            {
              label: "Delete",
              icon: null,
              permissions: { llmVirtualKey: ["delete"] },
            },
          ]}
        />
      ))}
    </>
  );
}

it.each([
  "creation",
  "billing-team update",
] as const)("refreshes cached capabilities after %s so member key actions become usable", async (operation) => {
  let created = operation !== "creation";
  let manageable = false;
  server.use(
    http.get(`${API}/api/llm-virtual-keys`, () =>
      HttpResponse.json({
        data: created
          ? [{ id: KEY_ID, name: "Member key", keyType: "passthrough" }]
          : [],
        pagination: { total: created ? 1 : 0 },
      }),
    ),
    http.get(`${API}/api/resource-permissions`, () =>
      HttpResponse.json(
        manageable
          ? ["read", "update", "delete"].map((action) => ({
              resource: "llmVirtualKey",
              action,
              scope: KEY_ID,
            }))
          : [],
      ),
    ),
    http.post(`${API}/api/llm-virtual-keys`, () => {
      created = true;
      manageable = true;
      return HttpResponse.json({ id: KEY_ID, name: "Member key" });
    }),
    http.patch(`${API}/api/llm-virtual-keys/:id`, () => {
      manageable = true;
      return HttpResponse.json({ id: KEY_ID, name: "Member key" });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authQueryKeys.session(), {
    user: { id: "lead" },
    session: { id: "session" },
  });
  client.setQueryData(authQueryKeys.userPermissions(), {});
  client.setQueryData(authQueryKeys.scopedCapabilities(), []);
  const onEdit = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <MemberKeys onEdit={onEdit} />
    </QueryClientProvider>,
  );
  if (operation !== "creation") {
    expect(
      await screen.findByRole("button", { name: "Edit Member key" }),
    ).toHaveAttribute("aria-disabled", "true");
  }
  await user.click(
    screen.getByRole("button", {
      name:
        operation === "creation" ? "Create member key" : "Change billing team",
    }),
  );
  const edit = await screen.findByRole("button", { name: "Edit Member key" });
  await waitFor(() =>
    expect(edit).not.toHaveAttribute("aria-disabled", "true"),
  );
  expect(
    screen.getByRole("button", { name: "Delete Member key" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await user.click(edit);
  expect(onEdit).toHaveBeenCalledOnce();
  client.clear();
});
