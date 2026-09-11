import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import SessionDetailPage from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

const origin = "http://localhost:9000";
const sessionsUrl = `${origin}/api/interactions/sessions`;
const emptySessions = {
  data: [],
  pagination: { limit: 1, nextCursor: null, hasNext: false },
};
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/llm/logs/session/test-session");
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get(sessionsUrl, () => HttpResponse.json(emptySessions)),
    http.get(`${origin}/api/interactions/summaries`, () =>
      HttpResponse.json({ data: [], pagination: { total: 0 } }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("replaces authorization-filtered session details with access guidance and a way back", async () => {
  await renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Session unavailable",
  );
  expect(screen.getByText(/ask an administrator/)).toBeVisible();
  for (const link of screen.getAllByRole("link", {
    name: "Back to Sessions",
  })) {
    expect(link).toHaveAttribute("href", "/llm/logs");
  }
  expect(screen.queryByText("Requests")).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Export JSON" }),
  ).not.toBeInTheDocument();
});

it("lets a failed session lookup recover on retry instead of claiming access is unavailable", async () => {
  server.use(
    http.get(sessionsUrl, () =>
      HttpResponse.json(
        {
          error: {
            message: "Unable to load session",
            type: "api_internal_server_error",
          },
        },
        { status: 500 },
      ),
    ),
  );
  await renderPage();
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByText("Session unavailable")).not.toBeInTheDocument();
  server.use(http.get(sessionsUrl, () => HttpResponse.json(emptySessions)));
  fireEvent.click(retry);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Session unavailable",
  );
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const params = Promise.resolve({ sessionId: "test-session" });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Suspense>
          <SessionDetailPage paramsPromise={params} />
        </Suspense>
      </QueryClientProvider>,
    );
  });
}
