import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { GithubManagedPolicyNotice } from "./github-managed-policy-notice";

vi.mock("@/lib/clients/auth/auth-client");

const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession(),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  server.use(
    http.get("http://localhost:9000/api/user/permissions", () =>
      HttpResponse.json(makeUserPermissions()),
    ),
  );
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test.each([
  [undefined, "blob/policy%2Fupdate/config/openappa.toml"],
  ["traces/required", "tree/policy%2Fupdate/traces/required"],
])("offers sync recovery for %s and removes guidance after success", async (validationDirectory, path) => {
  let lastSyncError: string | null = "GitHub returned HTTP 404";
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () =>
      HttpResponse.json({
        enabled: true,
        githubWebUrl: "https://github.com",
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
      <GithubManagedPolicyNotice validationDirectory={validationDirectory} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Git sync failed")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Review sync settings" }),
  ).toHaveAttribute("href", "/settings/guardrails");
  expect(screen.getByRole("link", { name: /repository/ })).toHaveAttribute(
    "href",
    `https://github.com/example/policies/${path}`,
  );
  expect(screen.getByRole("link", { name: /repository/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  lastSyncError = null;
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.queryByText("Git sync failed")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("link", { name: "Review sync settings" }),
  ).not.toBeInTheDocument();
  // A healthy sync is a chip linking to the same source, not a banner.
  expect(
    screen.getByRole("link", { name: /Managed in GitHub/ }),
  ).toHaveAttribute("href", `https://github.com/example/policies/${path}`);
  client.clear();
});

test("a pending setup pull request shows the Finish setup notice, whose wizard links it on the configured GitHub host", async () => {
  let lastSyncError: string | null = null;
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () =>
      HttpResponse.json({
        enabled: true,
        githubWebUrl: "https://github.example.com",
        source: {
          repo: "example/policies",
          ref: "main",
          path: "appa.toml",
          interval: "1h",
          setupPullRequestNumber: 7,
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
  // The one Finish setup notice, as on the Git sync settings.
  expect(await screen.findByText("Finish the Git sync setup")).toBeVisible();
  expect(screen.getByText("Merge PR #7.")).toBeVisible();
  expect(screen.queryByText("Managed in GitHub")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));
  expect(
    within(
      await screen.findByRole("dialog", { name: "Merge the pull request" }),
    ).getByRole("link", { name: "Initial policy #7" }),
  ).toHaveAttribute(
    "href",
    "https://github.example.com/example/policies/pull/7",
  );
  cleanup();
  // A failed sync outranks the setup: the error is what to act on.
  lastSyncError = "GitHub returned HTTP 403";
  await client.invalidateQueries();
  render(
    <QueryClientProvider client={client}>
      <GithubManagedPolicyNotice />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Git sync failed")).toBeVisible();
  expect(
    screen.queryByText("Finish the Git sync setup"),
  ).not.toBeInTheDocument();
  client.clear();
});
