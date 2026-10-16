import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { makeAgent } from "@/mocks/data/agents";
import { sessionSeed } from "@/mocks/data/auth";
import { organizationSeed } from "@/mocks/data/organization";
import { handlers } from "@/mocks/handlers";
import { InitialAgentSelector } from "./initial-agent-selector";

vi.mock("next/navigation");
vi.mock("sonner");
const origin = window.location.origin;
const server = setupServer(...handlers);
const clients: QueryClient[] = [];
const choices = Array.from({ length: 45 }, (_, index) =>
  makeAgent({
    id: `choice-${index}`,
    name: `Choice ${String(index).padStart(2, "0")}`,
    scope: "org",
    accessAllTools: true,
  }),
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  server.use(
    http.get(`${origin}/api/agents/chat-roster`, ({ request }) => {
      const ids = new URL(request.url).searchParams.get("ids")?.split(",");
      return HttpResponse.json(
        ids ? choices.filter((row) => ids.includes(row.id)) : [choices[0]],
      );
    }),
  );
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["auth", "session"], sessionSeed);
  client.setQueryData(["organization", "details"], organizationSeed);
  client.setQueryData(["member-default-agent"], {
    defaultAgentId: null,
    personalChatAgentId: null,
  });
  clients.push(client);
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <InitialAgentSelector
        currentAgentId={choices[0].id}
        onAgentChange={onChange}
      />
    </QueryClientProvider>,
  );
  return onChange;
}
function scrollBottom(list: HTMLElement) {
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 320 },
  });
  fireEvent.scroll(list, { target: { scrollTop: 680 } });
}
function pageData(rows: typeof choices, offset: number) {
  return {
    data: rows.slice(offset, offset + 20),
    pagination: {
      limit: 20,
      hasNext: offset + 20 < rows.length,
      nextCursor: offset + 20 < rows.length ? String(offset + 20) : null,
    },
  };
}

it("loads one bounded page per bottom scroll, appends without duplicate selection, and keeps keyboard selection", async () => {
  const requests: URL[] = [];
  const readinessBatches: string[][] = [];
  server.use(
    http.get(`${origin}/api/agents/credential-readiness`, ({ request }) => {
      readinessBatches.push(
        new URL(request.url).searchParams.get("ids")?.split(",") ?? [],
      );
      return HttpResponse.json([]);
    }),
  );
  let releaseNext!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  server.use(
    http.get(`${origin}/api/agents/chat-roster/page`, async ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      expect(url.searchParams.get("limit")).toBe("20");
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      if (offset === 20) await held;
      return HttpResponse.json(pageData(choices, offset));
    }),
  );
  const onChange = setup();
  const trigger = await screen.findByRole("combobox", { name: "Choice 00" });
  expect(requests).toHaveLength(0);
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /Choice 19/ });
  expect(requests).toHaveLength(1);
  expect(screen.getAllByRole("option")).toHaveLength(20);
  expect(
    screen.queryByRole("button", { name: "Load more agents" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Next" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Previous" }),
  ).not.toBeInTheDocument();
  const list = screen.getByRole("listbox", { name: "Agents" });
  scrollBottom(list);
  await waitFor(() => expect(requests).toHaveLength(2));
  scrollBottom(list);
  scrollBottom(list);
  expect(requests).toHaveLength(2);
  await act(async () => releaseNext());
  await screen.findByRole("option", { name: /Choice 39/ });
  expect(screen.getAllByRole("option")).toHaveLength(40);
  expect(screen.getByRole("option", { name: /Choice 00/ })).toBeInTheDocument();
  expect(requests).toHaveLength(2);
  scrollBottom(list);
  await screen.findByRole("option", { name: /Choice 44/ });
  expect(screen.getAllByRole("option")).toHaveLength(45);
  expect(requests).toHaveLength(3);
  await waitFor(() =>
    expect(readinessBatches.some((ids) => ids.includes("choice-44"))).toBe(
      true,
    ),
  );
  const firstBatch = choices
    .slice(0, 20)
    .map((choice) => choice.id)
    .sort()
    .join(",");
  expect(
    readinessBatches.filter((ids) => [...ids].sort().join(",") === firstBatch),
  ).toHaveLength(1);
  expect(readinessBatches.every((ids) => ids.length <= 20)).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Load more agents" }),
  ).not.toBeInTheDocument();
  act(() => screen.getByRole("option", { name: /Choice 43/ }).focus());
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith("choice-44");
});

it("keeps loaded choices after a failed scroll request and retries the same cursor", async () => {
  const cursors: string[] = [];
  let fail = true;
  server.use(
    http.get(`${origin}/api/agents/chat-roster/page`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
      cursors.push(cursor);
      return cursor && fail
        ? HttpResponse.json(
            { error: { message: "Temporarily unavailable" } },
            { status: 503 },
          )
        : HttpResponse.json(pageData(choices, Number(cursor)));
    }),
  );
  setup();
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Choice 00" }),
  );
  await screen.findByRole("option", { name: /Choice 19/ });
  const list = screen.getByRole("listbox", { name: "Agents" });
  scrollBottom(list);
  const retry = await screen.findByRole("button", {
    name: "Retry loading agents",
  });
  expect(screen.getAllByRole("option")).toHaveLength(20);
  scrollBottom(list);
  expect(cursors).toEqual(["", "20"]);
  fail = false;
  await userEvent.click(retry);
  await screen.findByRole("option", { name: /Choice 39/ });
  expect(cursors).toEqual(["", "20", "20"]);
});

it("isolates search results from an older in-flight scroll page", async () => {
  let releaseNext!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  let nextStarted = false;
  const requests: URL[] = [];
  server.use(
    http.get(`${origin}/api/agents/chat-roster/page`, async ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const search = url.searchParams.get("search") ?? "";
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      if (!search && offset === 20) {
        nextStarted = true;
        await held;
      }
      return HttpResponse.json(
        pageData(
          choices.filter((row) => row.name.includes(search)),
          offset,
        ),
      );
    }),
  );
  setup();
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Choice 00" }),
  );
  await screen.findByRole("option", { name: /Choice 19/ });
  scrollBottom(screen.getByRole("listbox", { name: "Agents" }));
  await waitFor(() => expect(nextStarted).toBe(true));
  await userEvent.type(
    screen.getByPlaceholderText("Search agents"),
    "Choice 42",
  );
  await screen.findByRole("option", { name: /Choice 42/ });
  await act(async () => releaseNext());
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(
    screen.queryByRole("option", { name: /Choice 20/ }),
  ).not.toBeInTheDocument();
  expect(requests.at(-1)?.searchParams.get("search")).toBe("Choice 42");
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
});
