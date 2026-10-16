import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentSelector } from "./agent-selector";

const ORIGIN = "http://localhost:9000";
const server = setupServer();
const clients: QueryClient[] = [];

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  server.resetHandlers();
  for (const client of clients.splice(0)) client.clear();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function option(id: string, name = id) {
  return {
    id,
    name,
    slug: id,
    agentType: "agent" as const,
    icon: null,
    scope: "org" as const,
    authorId: null,
    authorName: null,
    authorEmail: null,
    isPersonalGateway: false,
    runtime: null,
    description: null,
    teams: [],
    users: [],
  };
}
function page(
  data: ReturnType<typeof option>[],
  nextCursor: string | null = null,
) {
  return {
    data,
    pagination: { limit: 20, nextCursor, hasNext: nextCursor !== null },
  };
}
function mount(element: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}
function references(request: Request) {
  return (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .filter(Boolean);
}

describe("server-backed agent choices", () => {
  it("does not fetch a roster on mount, preserves an off-page value, and reaches later pages and owner search", async () => {
    const requests: URL[] = [];
    const selected: string[] = [];
    server.use(
      http.get(`${ORIGIN}/api/agents/options`, ({ request }) => {
        const ids = references(request);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThanOrEqual(100);
        return HttpResponse.json(
          ids.map((id) =>
            option(id, id === "retained" ? "Saved choice" : "Later choice"),
          ),
        );
      }),
      http.get(`${ORIGIN}/api/agents/options/page`, ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        if (url.searchParams.get("search"))
          return HttpResponse.json(
            page([option("owner-match", "Owned by teammate")]),
          );
        return HttpResponse.json(
          url.searchParams.get("cursor")
            ? page([option("later", "Later choice")])
            : page(
                Array.from({ length: 20 }, (_, i) => option(`first-${i}`)),
                "next-page",
              ),
        );
      }),
    );
    mount(
      <AgentSelector
        mode="single"
        flat
        remote={{ filters: { agentType: "agent" } }}
        value="retained"
        onValueChange={(id) => selected.push(id)}
      />,
    );
    expect(await screen.findByText("Saved choice")).toBeVisible();
    expect(requests).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByText("first-0")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("limit")).toBe("20");
    screen.getByRole("button", { name: "Next agents" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Later choice")).toBeVisible();
    expect(selected).toEqual([]);
    expect(requests[1].searchParams.get("cursor")).toBe("next-page");
    await user.type(
      screen.getByPlaceholderText("Search agents..."),
      "teammate",
    );
    expect(await screen.findByText("Owned by teammate")).toBeVisible();
    expect(requests.at(-1)?.searchParams.get("search")).toBe("teammate");
    await user.click(screen.getByText("Owned by teammate"));
    expect(selected).toEqual(["owner-match"]);
  });

  it("fetches complete IDs only after explicitly selecting all from an empty value", async () => {
    let idReads = 0;
    const selections: string[][] = [];
    server.use(
      http.get(`${ORIGIN}/api/agents/options/page`, () =>
        HttpResponse.json(page([option("first")], "next")),
      ),
      http.get(`${ORIGIN}/api/agents/options/ids`, () => {
        idReads += 1;
        return HttpResponse.json(["first", "unseen"]);
      }),
    );
    mount(
      <AgentSelector
        mode="multiple"
        flat
        remote={{ filters: { agentType: "agent" } }}
        value={[]}
        onValueChange={(ids) => selections.push(ids)}
        allOption={{ label: "All agents" }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByText("first")).toBeVisible();
    expect(idReads).toBe(0);
    await user.click(screen.getByRole("option", { name: "All agents" }));
    await waitFor(() => expect(selections).toEqual([["first", "unseen"]]));
    expect(idReads).toBe(1);
  });

  it("retains unseen selected IDs, bounds chip lookups, and Select all includes later candidates", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `saved-${i}`);
    const referenceSizes: number[] = [];
    const selections: string[][] = [];
    let allIdReads = 0;
    server.use(
      http.get(`${ORIGIN}/api/agents/options`, ({ request }) => {
        const wanted = references(request);
        referenceSizes.push(wanted.length);
        return HttpResponse.json(wanted.map((id) => option(id)));
      }),
      http.get(`${ORIGIN}/api/agents/options/ids`, () => {
        allIdReads += 1;
        return HttpResponse.json([...ids, "new-choice"]);
      }),
      http.get(`${ORIGIN}/api/agents/options/page`, () =>
        HttpResponse.json(page([option("new-choice", "New choice")])),
      ),
    );
    function Editor() {
      const [value, setValue] = useState(ids);
      return (
        <AgentSelector
          mode="multiple"
          flat
          remote={{ filters: { agentType: "agent" } }}
          value={value}
          onValueChange={(next) => {
            selections.push(next);
            setValue(next);
          }}
          allOption={{ label: "All agents" }}
        />
      );
    }
    mount(<Editor />);
    expect(await screen.findByText("saved-0")).toBeVisible();
    expect(screen.getByText("+25 selected")).toBeVisible();
    expect(referenceSizes).toEqual([20]);
    expect(allIdReads).toBe(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("New choice"));
    await waitFor(() =>
      expect(selections.at(-1)).toEqual([...ids, "new-choice"]),
    );
    expect(referenceSizes.every((size) => size <= 20)).toBe(true);
    // A saved complete selection collapses to the clicked individual, matching
    // the existing selector's explicit Select all behavior.
    await user.click(await screen.findByText("New choice"));
    expect(selections.at(-1)).toEqual(["new-choice"]);
    await user.click(await screen.findByRole("option", { name: "All agents" }));
    expect(selections.at(-1)).toEqual([...ids, "new-choice"]);
    expect(allIdReads).toBe(1);
  });
});
