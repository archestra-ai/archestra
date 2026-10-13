import { archestraApiClient, BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authClient } from "@/lib/clients/auth/auth-client";
import { resolveOpenAppaLaunchPrompt } from "@/lib/openappa-chat-prompts";
import { makeAgent } from "@/mocks/data/agents";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { OpenAppaChatButton } from "./openappa-chat-button";

vi.mock("@/lib/clients/auth/auth-client");

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
beforeEach(() => {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession(),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  server.use(
    http.get(`${api}/api/auth/get-session`, () =>
      HttpResponse.json(makeSession()),
    ),
    http.get(`${api}/api/user/permissions`, () =>
      HttpResponse.json(
        makeUserPermissions({
          openappaPolicy: ["read", "update"],
          openappaDiagnostics: ["read", "update", "admin"],
        }),
      ),
    ),
  );
});
function show(
  props: Partial<React.ComponentProps<typeof OpenAppaChatButton>> = {},
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, retryDelay: 0 } },
        })
      }
    >
      <TooltipProvider delayDuration={0}>
        <OpenAppaChatButton promptKey="setUpPolicy" {...props}>
          {props.children ?? "Create policy"}
        </OpenAppaChatButton>
      </TooltipProvider>
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

test("without a prompt the chat opens on the agent's suggested prompts", async () => {
  server.use(
    http.get(`${api}/api/agents/all`, () => HttpResponse.json([agent])),
  );
  show({ promptKey: undefined, children: "Ask about the policy" });
  expect(
    await screen.findByRole("link", { name: "Ask about the policy" }),
  ).toHaveAttribute("href", "/chat?agentId=config-agent");
});

test("an unavailable agent does not fall back to the user's default chat", async () => {
  server.use(http.get(`${api}/api/agents/all`, () => HttpResponse.json([])));
  show();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Create policy" }),
    ).toHaveAttribute("disabled"),
  );
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

test.each([
  { promptKey: undefined, children: "Ask about the policy" },
  {
    promptKey: "reviewCoverage" as const,
    children: "Ask",
    target: { kind: "mcp_gateway" as const, id: "gateway", name: "Research" },
  },
])("$children lists only missing permissions and cannot navigate", async (props) => {
  server.use(
    http.get(`${api}/api/agents/all`, () => HttpResponse.json([agent])),
    http.get(`${api}/api/user/permissions`, () =>
      HttpResponse.json({
        chat: ["read"],
        agent: ["read"],
        skill: ["read"],
        mcpGateway: ["read"],
        openappaPolicy: [],
        openappaDiagnostics: ["read"],
      }),
    ),
  );
  show(props);
  const button = await screen.findByRole("button", { name: props.children });
  await waitFor(() =>
    expect(button).toHaveAccessibleDescription(
      "Missing permissions: Chats (create), OpenAPPA Policy (read)",
    ),
  );
  await userEvent.click(button);
  expect(
    screen.queryByRole("link", { name: props.children }),
  ).not.toBeInTheDocument();
  await userEvent.unhover(button);
  await userEvent.hover(button);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Missing permissions");
  expect(tooltip).toHaveTextContent("Chats: create");
  expect(tooltip).toHaveTextContent("OpenAPPA Policy: read");
  expect(tooltip).not.toHaveTextContent("Diagnostics");
});
