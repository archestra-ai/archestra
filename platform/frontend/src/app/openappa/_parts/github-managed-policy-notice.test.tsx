import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { GithubManagedPolicyNotice } from "./github-managed-policy-notice";

const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("offers sync settings on failure and removes recovery guidance after sync succeeds", async () => {
  let lastSyncError: string | null = "GitHub returned HTTP 404";
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () =>
      HttpResponse.json({
        enabled: true,
        source: {
          repo: "example/policies",
          ref: "policy/update",
          path: "config/openappa.toml",
          lastSyncError,
        },
      }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GithubManagedPolicyNotice />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("GitHub sync failed")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Review sync settings" }),
  ).toHaveAttribute("href", "/settings/openappa");
  expect(screen.getByRole("link", { name: /repository/ })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/blob/policy%2Fupdate/config/openappa.toml",
  );
  expect(screen.getByRole("link", { name: /repository/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  lastSyncError = null;
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.queryByText("GitHub sync failed")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("link", { name: "Review sync settings" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Managed in GitHub")).toBeVisible();
  expect(screen.getByRole("link", { name: /repository/ })).toBeVisible();
  client.clear();
});
