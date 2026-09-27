import { archestraApiClient, BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { resolveOpenAppaLaunchPrompt } from "@/lib/openappa-chat-prompts";
import { makeAgent } from "@/mocks/data/agents";
import { OpenAppaChatButton } from "./openappa-chat-button";

const api = "http://localhost:9000";
const server = setupServer();
const agent = makeAgent({
  id: "config-agent",
  name: "OpenAPPA Configuration Agent",
  scope: "org",
  builtIn: true,
  builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
  authorId: null,
});
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: api });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, retryDelay: 0 } },
        })
      }
    >
      <OpenAppaChatButton promptKey="setUpPolicy">
        Create policy
      </OpenAppaChatButton>
    </QueryClientProvider>,
  );
}

test("launch resolves the system agent from the chat roster rather than a user-created copy", async () => {
  server.use(
    http.get(`${api}/api/agents/all`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      if (query.get("view") !== "chat") return HttpResponse.json([]);
      return HttpResponse.json([
        makeAgent({
          id: "copy",
          name: agent.name,
          labels: [{ key: "purpose", value: "openappa-configuration" }],
        }),
        agent,
      ]);
    }),
  );
  show();
  const link = await screen.findByRole("link", { name: "Create policy" });
  const url = new URL(link.getAttribute("href") ?? "", api);
  expect([...url.searchParams.keys()]).toEqual(["agentId", "user_prompt"]);
  expect(url.searchParams.get("agentId")).toBe(agent.id);
  expect(url.searchParams.get("user_prompt")).toBe(
    resolveOpenAppaLaunchPrompt("setUpPolicy"),
  );
});

test("an unavailable agent does not fall back to the user's default chat", async () => {
  server.use(http.get(`${api}/api/agents/all`, () => HttpResponse.json([])));
  show();
  expect(
    await screen.findByRole("button", { name: "Create policy" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("link", { name: "Create policy" }),
  ).not.toBeInTheDocument();
});

test("a failed agent lookup can be retried from the CTA", async () => {
  let available = false;
  server.use(
    http.get(`${api}/api/agents/all`, () => {
      return !available
        ? HttpResponse.json(
            { error: "temporarily unavailable" },
            { status: 503 },
          )
        : HttpResponse.json([agent]);
    }),
  );
  show();
  const retry = await screen.findByTitle(
    "Could not load the chat agent. Click to retry.",
  );
  available = true;
  await userEvent.click(retry);
  expect(
    await screen.findByRole("link", { name: "Create policy" }),
  ).toHaveAttribute("href", expect.stringContaining("agentId=config-agent"));
});
