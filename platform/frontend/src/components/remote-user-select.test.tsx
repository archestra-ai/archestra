import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
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
import { useMemberOptionsReferences } from "@/lib/member-options.query";
import { RemoteUserSelect } from "./remote-user-select";

vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  server.resetHandlers();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return {
    client,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
const users = Array.from({ length: 45 }, (_, index) => ({
  id: `user-${index}`,
  name: `Person ${String(index).padStart(2, "0")}`,
  email: `person-${index}@example.com`,
}));

it("resolves a URL-selected user without a roster and pages/searches only on demand", async () => {
  const pageRequests: string[] = [];
  const referenceRequests: string[] = [];
  server.use(
    http.get(`${origin}/api/organization/member-options`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const ids = params.get("ids");
      if (ids) {
        referenceRequests.push(ids);
        return HttpResponse.json({
          data: users.filter((row) => ids.split(",").includes(row.id)),
          pagination: { limit: 100, hasNext: false, nextCursor: null },
        });
      }
      expect(params.get("limit")).toBe("20");
      pageRequests.push(request.url);
      const filtered = users.filter((row) =>
        row.name
          .toLowerCase()
          .includes(params.get("search")?.toLowerCase() ?? ""),
      );
      const offset = Number(params.get("cursor") ?? 0);
      return HttpResponse.json({
        data: filtered.slice(offset, offset + 20),
        pagination: {
          limit: 20,
          hasNext: offset + 20 < filtered.length,
          nextCursor:
            offset + 20 < filtered.length ? String(offset + 20) : null,
        },
      });
    }),
  );
  window.history.replaceState(null, "", "/mcp/logs?userId=user-44");
  const value =
    new URLSearchParams(window.location.search).get("userId") ?? "all";
  const { wrapper, client } = setup();
  render(
    <RemoteUserSelect
      value={value}
      onValueChange={(id) =>
        window.history.replaceState(null, "", `/mcp/logs?userId=${id}`)
      }
      pinnedOption={{ value: "all", label: "All Users" }}
    />,
    { wrapper },
  );
  const trigger = screen.getByRole("combobox");
  await waitFor(() => expect(trigger).toHaveTextContent("Person 44"));
  expect(referenceRequests).toEqual(["user-44"]);
  expect(pageRequests).toHaveLength(0);
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /Person 00/ });
  expect(screen.getAllByRole("option")).toHaveLength(21);
  expect(pageRequests).toHaveLength(1);
  const next = screen.getByRole("button", { name: "Next users" });
  next.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("option", { name: /Person 20/ });
  expect(window.location.search).toBe("?userId=user-44");
  expect(pageRequests).toHaveLength(2);
  await userEvent.type(
    screen.getByPlaceholderText("Search users"),
    "Person 42",
  );
  await userEvent.click(
    await screen.findByRole("option", { name: /Person 42/ }),
  );
  expect(window.location.search).toBe("?userId=user-42");
  client.clear();
});

it("keeps the saved selection after a failed page and permits retry", async () => {
  let attempts = 0;
  server.use(
    http.get(`${origin}/api/organization/member-options`, ({ request }) => {
      if (new URL(request.url).searchParams.has("ids"))
        return HttpResponse.json({
          data: [users[44]],
          pagination: { limit: 100, hasNext: false, nextCursor: null },
        });
      attempts += 1;
      return attempts === 1
        ? HttpResponse.json(
            { error: { message: "Unavailable" } },
            { status: 503 },
          )
        : HttpResponse.json({
            data: [users[0]],
            pagination: { limit: 20, hasNext: false, nextCursor: null },
          });
    }),
  );
  const onChange = vi.fn();
  const { wrapper, client } = setup();
  render(<RemoteUserSelect value="user-44" onValueChange={onChange} />, {
    wrapper,
  });
  const trigger = screen.getByRole("combobox");
  await waitFor(() => expect(trigger).toHaveTextContent("Person 44"));
  await userEvent.click(trigger);
  await userEvent.click(
    await screen.findByRole("button", { name: "Retry loading users" }),
  );
  await screen.findByRole("option", { name: /Person 00/ });
  expect(onChange).not.toHaveBeenCalled();
  expect(trigger).toHaveTextContent("Person 44");
  client.clear();
});

it("chunks only explicit identity references and does nothing for empty references", async () => {
  const batches: string[][] = [];
  server.use(
    http.get(`${origin}/api/organization/member-options`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const ids = params.get("ids")?.split(",");
      expect(ids).toBeDefined();
      expect(ids?.length).toBeLessThanOrEqual(100);
      batches.push(ids ?? []);
      return HttpResponse.json({
        data: (ids ?? []).map((id) => ({
          id,
          name: id,
          email: `${id}@example.com`,
        })),
        pagination: { limit: 100, hasNext: false, nextCursor: null },
      });
    }),
  );
  const { wrapper, client } = setup();
  const { result, rerender } = renderHook(
    ({ ids }) => useMemberOptionsReferences({ ids }),
    { wrapper, initialProps: { ids: [] as string[] } },
  );
  expect(batches).toHaveLength(0);
  rerender({
    ids: Array.from({ length: 205 }, (_, index) => `reference-${index}`),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toHaveLength(205);
  expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
  client.clear();
});
