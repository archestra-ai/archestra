import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ChatPage } from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

const origin = "http://localhost:9000";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/llm/logs/test-interaction-id");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(http.get(`${origin}/api/agents/all`, () => HttpResponse.json([])));
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it.each([
  0.0042, 0,
])("shows the OpenRouter charge %s separately from the estimate", async (cost) => {
  renderInteraction({ cost });

  const reported = await screen.findByText("OpenRouter-reported cost");
  expect(reported.parentElement).toHaveTextContent(
    cost === 0 ? "$0.00" : "$0.004200",
  );
  const estimated = screen.getByText("Estimated cost");
  expect(estimated.parentElement).toHaveTextContent("$0.0100");
});

it.each([
  undefined,
  null,
  -1,
  "0.0042",
])("does not substitute an estimate for unavailable charge %s", async (cost) => {
  renderInteraction({ cost });

  const reported = await screen.findByText("OpenRouter-reported cost");
  expect(reported.parentElement).toHaveTextContent("Unavailable");
  expect(screen.getByText("Estimated cost")).toBeVisible();
});

it("keeps the existing cost display for other providers", async () => {
  renderInteraction({ cost: 0.0042, type: "openai:chatCompletions" });

  expect(await screen.findByText("Cost", { exact: true })).toBeVisible();
  expect(
    screen.queryByText("OpenRouter-reported cost"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Estimated cost")).not.toBeInTheDocument();
});

function renderInteraction({
  cost,
  type = "openrouter:chatCompletions",
}: {
  cost: unknown;
  type?: string;
}) {
  const interaction = {
    id: "test-interaction-id",
    profileId: null,
    model: "openai/gpt-4o",
    cost: "0.01",
    baselineCost: "0.01",
    billingMode: "metered",
    inputTokens: 100,
    outputTokens: 50,
    createdAt: "2026-09-15T12:00:00.000Z",
    request: {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    },
    response: {
      id: "gen-test",
      object: "chat.completion",
      model: "openai/gpt-4o",
      created: 0,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello!" },
        },
      ],
    },
  };
  server.use(
    http.get(`${origin}/api/interactions/test-interaction-id`, () =>
      HttpResponse.json({
        ...interaction,
        type,
        response: {
          ...interaction.response,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            cost,
          },
        },
      }),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChatPage id="test-interaction-id" />
    </QueryClientProvider>,
  );
}
