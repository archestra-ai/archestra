import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { AgentRunOpenappaReview } from "./openappa-review-card";

const server = setupServer();
const origin = "http://localhost:9000";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("lets the owner approve the exact offer and hides that offer from a shared viewer", async () => {
  const user = userEvent.setup();
  let body: unknown;
  server.use(
    http.get(`${origin}/api/agent-runs/task-1/openappa-review`, () =>
      HttpResponse.json({
        status: "pending",
        canDecide: true,
        offerId: "offer-1",
        text: "Send the file?",
        tool: "mcp/example/write",
        arguments: '{"path":"secret.txt"}',
      }),
    ),
    http.post(
      `${origin}/api/agent-runs/task-1/openappa-review`,
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          decision: "approve",
          offerId: "offer-1",
          steered: false,
        });
      },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <AgentRunOpenappaReview taskId="task-1" />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("button", { name: "Approve" }),
  ).toBeInTheDocument();
  expect(document.body).toHaveTextContent("secret.txt");
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(body).toEqual({ decision: "approve", offerId: "offer-1" }),
  );
  unmount();

  server.use(
    http.get(`${origin}/api/agent-runs/task-2/openappa-review`, () =>
      HttpResponse.json({
        status: "pending",
        canDecide: false,
        offerId: null,
        text: null,
        tool: null,
        arguments: null,
      }),
    ),
  );
  render(
    <QueryClientProvider client={client}>
      <AgentRunOpenappaReview taskId="task-2" />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(
      "This run is waiting for its owner to approve or deny a blocked action.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("secret.txt")).not.toBeInTheDocument();
});
