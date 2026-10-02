import { archestraApiClient } from "@archestra/shared";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
import { OpenappaSessionStatus } from "./openappa-session-status";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/guardrails-deployment.query", () => ({
  useGuardrailsDeployment: () => ({ data: { active: true } }),
}));
vi.mock("sonner");

import { openappaStatusQueryKey } from "@/lib/chat/chat.query";
import { useFeature } from "@/lib/config/config.query";

const server = setupServer(
  http.get("/api/chat/conversations/:id/openappa-status", ({ params }) =>
    HttpResponse.json({
      trust: params.id === "second" ? "reviewed" : "trusted",
      audience: params.id === "second" ? "internal" : "public",
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
});

it("hides retained labels after a failed refresh and recovers on reconnect", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <OpenappaSessionStatus conversationId="first" />
    </QueryClientProvider>,
  );
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public",
  });
  server.use(
    http.get("/api/chat/conversations/:id/openappa-status", () =>
      HttpResponse.json({ error: { message: "Offline" } }, { status: 503 }),
    ),
  );
  await client.refetchQueries({
    queryKey: openappaStatusQueryKey("first"),
  });
  await screen.findByRole("status", {
    name: "Trust and audience status unavailable",
  });
  expect(screen.getByRole("status")).not.toHaveTextContent("trusted");
  server.resetHandlers();
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public",
  });
  view.unmount();
  client.clear();
});

it("reads the newly selected session as a noninteractive status", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (id: string) => (
    <QueryClientProvider client={client}>
      <OpenappaSessionStatus key={id} conversationId={id} />
    </QueryClientProvider>
  );
  const view = render(content("first"));
  await screen.findByRole("status", {
    name: "Trust: trusted; audience: public",
  });
  view.rerender(content("second"));
  await screen.findByRole("status", {
    name: "Trust: reviewed; audience: internal",
  });
  expect(
    screen.queryByRole("status", { name: "Trust: trusted; audience: public" }),
  ).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  client.clear();
});
