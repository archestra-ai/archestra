import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ALL_INCLUDED } from "./connect-choices";
import type { ConnectPageData } from "./connect-page-data";
import { BrowseDialog } from "./connect-page-parts";

const api = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  api.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  api.resetHandlers();
});
afterAll(() => api.close());

it("requests skill pages only when opened or navigated and searches the whole catalogue", async () => {
  const requests: { offset: number; search: string | null }[] = [];
  api.use(
    http.get("http://localhost:9000/api/skills", ({ request }) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("offset"));
      const search = url.searchParams.get("search");
      requests.push({ offset, search });
      expect(url.searchParams.get("includeContent")).toBe("false");
      const name = search ? "Faraway skill" : `Page ${offset / 100 + 1} skill`;
      return HttpResponse.json({
        data: [
          {
            id: `skill-${offset}`,
            name,
            description: "Useful instructions",
            scope: "org",
            usageCount: 0,
          },
        ],
        pagination: { total: search ? 1 : 350, limit: 100, offset },
      });
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const data = {
    servers: [],
    skillsEnabled: true,
    totalSkills: 350,
    partsFor: () => ({ skills: true }),
    pluginsFor: () => [],
  } as unknown as ConnectPageData;
  const show = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <BrowseDialog
        open={open}
        tab="skills"
        focus={null}
        onTab={() => {}}
        onOpenChange={() => {}}
        data={data}
        client={CONNECT_CLIENTS[0]}
        skills={[]}
        choices={ALL_INCLUDED}
      />
    </QueryClientProvider>
  );
  const view = render(show(false));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(requests).toEqual([]);
  view.rerender(show(true));
  expect(await screen.findByText("Page 1 skill")).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(requests).toEqual([{ offset: 0, search: null }]);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("Page 2 skill")).toBeVisible();
  await userEvent.type(screen.getByPlaceholderText("Search skills"), "Faraway");
  expect(await screen.findByText("Faraway skill")).toBeVisible();
  await waitFor(() =>
    expect(requests.at(-1)).toEqual({ offset: 0, search: "Faraway" }),
  );
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
});
