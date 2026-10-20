import { archestraApiClient } from "@archestra/shared";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ChatComposerSecurity } from "./chat-composer-security";

const mocks = vi.hoisted(() => ({
  deployment: { active: true, enabled: true, featureEnabled: true },
  permissions: { guardrailsPolicy: true },
}));

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/guardrails-deployment.query", () => ({
  useGuardrailsDeployment: () => ({ data: mocks.deployment }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: (check: Record<string, string[]>) => ({
    data: Object.keys(check).every(
      (resource) =>
        mocks.permissions[resource as keyof typeof mocks.permissions],
    ),
  }),
}));
vi.mock("sonner");

import { YELL_RESULT_GUARDRAILS_OFF } from "@archestra/shared";
import { openappaStatusQueryKey } from "@/lib/chat/chat.query";
import { conversationQueryKey } from "@/lib/chat/conversations-query-key";
import { useFeature } from "@/lib/config/config.query";

const server = setupServer(
  http.get("/api/chat/conversations/:id/openappa-status", ({ params }) =>
    HttpResponse.json({
      trust: params.id === "second" ? "reviewed" : "trusted",
      audience: params.id === "second" ? "internal" : "public",
      policyRevision: null,
      newSessionPolicy: "live",
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(useFeature).mockImplementation((flag) =>
    flag === "openappaEnabled" ? true : undefined,
  );
  mocks.deployment = { active: true, enabled: true, featureEnabled: true };
  mocks.permissions = { guardrailsPolicy: true };
});

it("hides retained labels after a failed refresh and recovers on reconnect", async () => {
  const { client, view } = renderPeek("first");
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public; policy snapshot",
  });
  server.use(
    http.get("/api/chat/conversations/:id/openappa-status", () =>
      HttpResponse.json({ error: { message: "Offline" } }, { status: 503 }),
    ),
  );
  await client.refetchQueries({
    queryKey: openappaStatusQueryKey("first"),
  });
  await waitFor(() => expect(peekButton()).toBeNull());
  expect(screen.queryByRole("status")).toBeNull();
  server.resetHandlers();
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public; policy snapshot",
  });
  view.unmount();
  client.clear();
});

it("reads the newly selected session's labels", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (id: string) => (
    <QueryClientProvider client={client}>
      <ChatComposerSecurity key={id} conversationId={id} />
    </QueryClientProvider>
  );
  const view = render(content("first"));
  await screen.findByRole("button", {
    name: "Guardrails: trust trusted, audience public",
  });
  view.rerender(content("second"));
  await screen.findByRole("button", {
    name: "Guardrails: trust reviewed, audience internal",
  });
  expect(
    screen.queryByRole("status", {
      name: "Trust: trusted; audience: public; policy snapshot",
    }),
  ).toBeNull();
  view.unmount();
  client.clear();
});

it("opens the labels as today, with the title linking to the Guardrails page", async () => {
  respondWith({ trust: "trusted", audience: "public", policyRevision: 7 });
  const { client, view } = renderPeek("revised");
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public; policy revision: 7",
  });
  await userEvent.click(peekButton() as HTMLElement);
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("trust:trusted");
  expect(dialog).toHaveTextContent("audience:public");
  expect(dialog).toHaveTextContent("revision:7");
  expect(
    screen.getByRole("link", { name: "Guardrails are enabled" }),
  ).toHaveAttribute("href", "/openappa");
  view.unmount();
  client.clear();
});

it("shows the title as plain text to people who cannot read the policy", async () => {
  mocks.permissions.guardrailsPolicy = false;
  const { client, view } = renderPeek("no-policy-access");
  await userEvent.click(
    await screen.findByRole("button", { name: /^Guardrails:/ }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Guardrails are enabled");
  expect(
    screen.queryByRole("link", { name: "Guardrails are enabled" }),
  ).toBeNull();
  view.unmount();
  client.clear();
});

it.each([
  ["a session that keeps a policy snapshot", null, true, "snapshot"],
  ["a session that follows a frozen revision", 4, false, "snapshot"],
  ["a session that keeps a policy snapshot", null, true, "live"],
  ["a session that follows the current revision", 4, false, "live"],
])("names the policy of %s with revision %s (snapshot %s; new mode %s)", async (_name, policyRevision, snapshot, newSessionPolicy) => {
  respondWith({
    trust: "trusted",
    audience: "public",
    policyRevision,
    newSessionPolicy,
  });
  const { client, view } = renderPeek(`snapshot-${policyRevision}`);
  await screen.findByRole("status", {
    name: snapshot
      ? "Trust: trusted; audience: public; policy snapshot"
      : `Trust: trusted; audience: public; policy revision: ${policyRevision}`,
  });
  await userEvent.click(peekButton() as HTMLElement);
  const dialog = await screen.findByRole("dialog");
  if (snapshot) expect(dialog).toHaveTextContent("policy snapshot");
  else expect(dialog).not.toHaveTextContent("policy snapshot");
  view.unmount();
  client.clear();
});

it("hides APPA when a conversation has no APPA session", async () => {
  const id = "no-session";
  respondWith(null);
  const { client, view } = renderPeek(id);
  await waitFor(() =>
    expect(client.getQueryState(openappaStatusQueryKey(id))?.status).toBe(
      "success",
    ),
  );
  expect(peekButton()).toBeNull();
  view.unmount();
  client.clear();
});

it("hides APPA while the first status is loading, then shows it", async () => {
  let resolveStatus!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolveStatus = resolve;
  });
  server.use(
    http.get("/api/chat/conversations/:id/openappa-status", async () => {
      await pending;
      return HttpResponse.json({ trust: "trusted", audience: "public" });
    }),
  );
  const { client, view } = renderPeek("loading", new QueryClient());
  await waitFor(() =>
    expect(
      client.getQueryState(openappaStatusQueryKey("loading"))?.fetchStatus,
    ).toBe("fetching"),
  );
  expect(peekButton()).toBeNull();
  resolveStatus();
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public",
  });
  view.unmount();
  client.clear();
});

it("shows calm APPA without labels before a new chat has a session", async () => {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ChatComposerSecurity />
    </QueryClientProvider>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Guardrails are enabled" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).not.toHaveTextContent("trust:");
  expect(screen.queryByRole("status")).toBeNull();
  view.unmount();
  client.clear();
});

it.each([
  [
    "asleep for a chat that started while enforcement was off",
    { messages: [{ id: "m1", role: "assistant", parts: [] }] },
    "Guardrails don't check this chat",
    "It started while enforcement was off.",
  ],
  [
    "in shades once a yell broke the glass in the chat",
    {
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-archestra__yell",
              toolCallId: "call-1",
              state: "output-available",
              output: {
                content: [
                  {
                    type: "text",
                    text: `Reported.\n${YELL_RESULT_GUARDRAILS_OFF}`,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    "Guardrails are off in this chat",
    "The glass was broken",
  ],
])("shows APPA %s", async (_name, conversation, title, body) => {
  respondWith(null);
  respondWithConversation(conversation);
  const { client, view } = renderPeek("uncovered");
  await userEvent.click(await screen.findByRole("button", { name: title }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent(body);
  expect(screen.queryByRole("status")).toBeNull();
  view.unmount();
  client.clear();
});

it("stays calm, not asleep, before the first reply opens a session", async () => {
  respondWith(null);
  respondWithConversation({
    messages: [{ id: "m1", role: "user", parts: [] }],
  });
  const { client, view } = renderPeek("first-turn");
  expect(
    await screen.findByRole("button", { name: "Guardrails are enabled" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Guardrails don't check this chat" }),
  ).toBeNull();
  view.unmount();
  client.clear();
});

it("hides APPA for an encrypted chat this browser cannot open", async () => {
  const id = "locked";
  respondWith(null);
  respondWithConversation({ messages: [], contentLocked: true });
  const { client, view } = renderPeek(id);
  await waitFor(() =>
    expect(client.getQueryState(conversationQueryKey(id))?.status).toBe(
      "success",
    ),
  );
  expect(peekButton()).toBeNull();
  view.unmount();
  client.clear();
});

it("links to the Guardrails page from a chat while enforcement is off", async () => {
  mocks.deployment = { active: false, enabled: false, featureEnabled: true };
  const { client, view } = renderPeek("off");
  await userEvent.click(
    screen.getByRole("button", { name: "Guardrails enforcement is off" }),
  );
  await screen.findByRole("dialog");
  expect(
    screen.getByRole("link", { name: "Guardrails enforcement is off" }),
  ).toHaveAttribute("href", "/openappa");
  expect(screen.queryByRole("status")).toBeNull();
  view.unmount();
  client.clear();
});

it("says enforcement is off without a link to someone who cannot open the page", async () => {
  mocks.deployment = { active: false, enabled: false, featureEnabled: true };
  mocks.permissions.guardrailsPolicy = false;
  const { client, view } = renderPeek("off-read-only");
  await userEvent.click(
    screen.getByRole("button", { name: "Guardrails enforcement is off" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Guardrails enforcement is off");
  expect(screen.queryByRole("link")).toBeNull();
  view.unmount();
  client.clear();
});

function renderPeek(
  conversationId: string,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  const view = render(
    wrap(<ChatComposerSecurity conversationId={conversationId} />),
  );
  return { client, view };
}

function respondWith(body: unknown) {
  server.use(
    http.get("/api/chat/conversations/:id/openappa-status", () =>
      HttpResponse.json(body as Record<string, unknown> | null),
    ),
  );
}

function respondWithConversation(body: Record<string, unknown>) {
  server.use(
    http.get("/api/chat/conversations/:id", ({ params }) =>
      HttpResponse.json({ id: params.id, encryptedChat: false, ...body }),
    ),
  );
}

function peekButton() {
  return screen.queryByRole("button", { name: /^Guardrails/ });
}
