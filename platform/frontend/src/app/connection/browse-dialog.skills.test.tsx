import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { BrowseDialog } from "./browse-dialog";
import { CONNECT_CLIENTS } from "./clients";
import { ALL_INCLUDED } from "./connect-choices";
import type { ConnectPageData } from "./connect-page-data";

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

it.each([
  true,
  false,
])("loads skills only on demand and with read permission (%s)", async (canRead) => {
  const requests: { limit: number; search: string | null }[] = [];
  api.use(
    http.get("http://localhost:9000/api/skills", ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit"));
      const search = url.searchParams.get("search");
      requests.push({ limit, search });
      expect(url.searchParams.get("includeContent")).toBe("false");
      const names = search
        ? ["Faraway skill"]
        : Array.from({ length: limit }, (_, i) => `Skill ${i + 1}`);
      return HttpResponse.json({
        data: names.map((name, i) => ({
          id: `skill-${i}`,
          name,
          description: "Useful instructions",
          scope: "org",
          usageCount: 0,
        })),
        pagination: { total: search ? 1 : 35, limit, offset: 0 },
      });
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), {
    user: { id: "test-user" },
  });
  queryClient.setQueryData(authQueryKeys.userPermissions(), {
    skill: canRead ? ["read"] : [],
  });
  const data = {
    servers: [],
    skillsEnabled: true,
    totalSkills: 35,
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
        choices={ALL_INCLUDED}
      />
    </QueryClientProvider>
  );
  const view = render(show(false));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(requests).toEqual([]);
  view.rerender(show(true));
  if (!canRead) {
    expect(
      await screen.findByText("You don’t have access to skills."),
    ).toBeVisible();
    expect(requests).toEqual([]);
    return;
  }
  // A skill's name opens its page; the dialog itself only lists.
  expect(await screen.findByRole("link", { name: "Skill 1" })).toHaveAttribute(
    "href",
    "/skills/skill-0",
  );
  expect(screen.queryByRole("link", { name: "Skill 21" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show 15 more" }));
  expect(await screen.findByRole("link", { name: "Skill 35" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  await userEvent.type(screen.getByPlaceholderText("Search skills"), "Faraway");
  expect(await screen.findByText("Faraway skill")).toBeVisible();
  await waitFor(() =>
    expect(requests.at(-1)).toEqual({ limit: 20, search: "Faraway" }),
  );
});
