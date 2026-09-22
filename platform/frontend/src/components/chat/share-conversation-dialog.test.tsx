// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ShareAgentRunDialog } from "./share-agent-run-dialog";
import { ShareConversationDialog } from "./share-conversation-dialog";

const origin = "http://localhost:9000";
const scope = "11111111-1111-4111-8111-111111111111";
const server = setupServer();
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it.each([
  "conversation",
  "agentRun",
] as const)("%s adds team access in one dialog and saves only session capabilities", async (resource) => {
  const user = userEvent.setup();
  const ownerGrant = {
    subject: { type: "user", id: "owner" },
    name: "Owner",
    actions: ["read", "manage-permissions"],
  };
  let policy = {
    resource,
    scope,
    name: "Review",
    revision: 1,
    grants: [ownerGrant],
    inheritedGrants: [],
    legacyAccess: [],
    effectiveActions: ["read", "manage-permissions"],
  };
  let saved: unknown;
  server.use(
    http.get(`${origin}/api/resource-permissions/${resource}/${scope}`, () =>
      HttpResponse.json(policy),
    ),
    http.get(
      `${origin}/api/resource-permissions/${resource}/${scope}/subjects`,
      () =>
        HttpResponse.json([
          { subject: { type: "team", id: "support" }, name: "Support" },
        ]),
    ),
    http.put(
      `${origin}/api/resource-permissions/${resource}/${scope}`,
      async ({ request }) => {
        saved = await request.json();
        policy = { ...policy, revision: 2 };
        return HttpResponse.json(policy);
      },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      {resource === "conversation" ? (
        <ShareConversationDialog
          conversationId={scope}
          appIds={["app-1"]}
          open
          onOpenChange={vi.fn()}
        />
      ) : (
        <ShareAgentRunDialog taskId={scope} open onOpenChange={vi.fn()} />
      )}
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole("dialog");
  await screen.findByText("Owner");
  if (resource === "conversation")
    expect(
      screen.getByText(/Apps in this chat have their own permissions/),
    ).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Add access" }));
  await user.click(screen.getByRole("button", { name: /Teams/ }));
  await user.click(screen.getByRole("combobox", { name: "Add teams" }));
  await user.click(await screen.findByRole("option", { name: /Support/ }));
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(screen.queryByText("Can edit")).not.toBeInTheDocument();
  expect(screen.queryByText("Full access")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Add access" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Save permissions" }),
  );
  await waitFor(() =>
    expect(saved).toEqual({
      revision: 1,
      grants: [
        {
          subject: { type: "user", id: "owner" },
          actions: ["read", "manage-permissions"],
        },
        { subject: { type: "team", id: "support" }, actions: ["read"] },
      ],
    }),
  );
});
