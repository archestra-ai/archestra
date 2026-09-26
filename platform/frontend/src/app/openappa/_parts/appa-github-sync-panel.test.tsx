import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AppaGithubSyncPanel } from "./appa-github-sync-panel";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const url = "http://localhost:9000/api/openappa/github-sync";
const server = setupServer();
let state: archestraApiTypes.GetAppaGithubSyncResponses["200"];
const source = {
  organizationId: "org",
  repo: "example/policies",
  ref: "main",
  path: "appa.toml",
  interval: "1h" as const,
  githubPatId: null,
  githubAppConfigId: null,
  revision: "revision",
  sourceCommit: "a".repeat(40),
  lastSyncedAt: "2026-09-15T12:00:00Z",
  lastSyncError: null,
  declarationsPendingPublish: false,
  heldContentHash: null,
  heldSourceCommit: null,
  heldReasons: [],
};
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  state = { enabled: true, hasPolicy: true, source };
  server.use(http.get(url, () => HttpResponse.json(state)));
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show(content = <AppaGithubSyncPanel />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  return client;
}

test("syncs on demand and shows the server's failure while retaining the source", async () => {
  server.use(
    http.patch(url, async ({ request }) => {
      expect(await request.json()).toEqual({ action: "sync" });
      state = {
        ...state,
        source: { ...source, lastSyncError: "GitHub returned HTTP 403" },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub returned HTTP 403",
  );
  expect(screen.getByRole("link", { name: /example\/policies/ })).toBeVisible();
});

test("confirms disconnect, stops automatic updates and preserves the accepted policy", async () => {
  server.use(
    http.patch(url, async ({ request }) => {
      expect(await request.json()).toEqual({ action: "disconnect" });
      state = { ...state, source: { ...source, interval: null } };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Stop syncing" }));
  expect(await screen.findByText("Stop APPA policy sync?")).toBeVisible();
  const buttons = screen.getAllByRole("button", { name: "Stop syncing" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("button", { name: "Reconnect GitHub" }),
  ).toBeVisible();
  expect(
    screen.getByText(/You can edit the current policy above/),
  ).toBeVisible();
});

test("read-only users see status without mutation controls", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(await screen.findByText("GitHub connected")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Sync now" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Edit source" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "APPA sync frequency" }),
  ).toBeDisabled();
});

test("a load failure stays an error until the user retries", async () => {
  server.use(http.get(url, () => new HttpResponse(null, { status: 503 })));
  show();
  expect(await screen.findByText("Could not load APPA sync")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Connect GitHub" }),
  ).not.toBeInTheDocument();
  server.use(http.get(url, () => HttpResponse.json(state)));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("GitHub connected")).toBeVisible();
});

test("connects a public repository and renders the saved source", async () => {
  state = { enabled: true, hasPolicy: false, source: null };
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
    http.put(url, async ({ request }) => {
      expect(await request.json()).toEqual({
        repo: "example/policies",
        ref: null,
        path: "appa.toml",
        interval: "1h",
        githubPatId: null,
        githubAppConfigId: null,
      });
      state = {
        enabled: true,
        hasPolicy: false,
        source: {
          ...source,
          ref: null,
          sourceCommit: null,
          lastSyncedAt: null,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create GitHub repository" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect existing repository" }),
  );
  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: "example/policies" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  expect(await screen.findByText("Waiting for the first sync")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("creates a repository with a connected App and shows the synced source", async () => {
  state = { enabled: true, hasPolicy: true, source: null };
  const appId = "11111111-1111-4111-8111-111111111111";
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([
        {
          id: appId,
          name: "Policy App",
          kind: "github_app",
          allowOrganization: true,
          organizationConfigured: true,
        },
      ]),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      expect(await request.json()).toEqual({
        owner: "example",
        name: "openappa-config",
        githubAppConfigId: appId,
        interval: "1h",
      });
      state = {
        enabled: true,
        hasPolicy: true,
        source: { ...source, repo: "example/openappa-config" },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create GitHub repository" }),
  );
  fireEvent.change(screen.getByLabelText("GitHub owner"), {
    target: { value: "example" },
  });
  expect(
    screen.getByRole("button", { name: "Create and sync" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("combobox", { name: "GitHub App" }));
  fireEvent.click(await screen.findByRole("option", { name: "Policy App" }));
  fireEvent.click(screen.getByRole("button", { name: "Create and sync" }));
  expect(
    await screen.findByRole("link", { name: /example\/openappa-config/ }),
  ).toBeVisible();
});

test("asks before discarding a GitHub source draft", async () => {
  state = { enabled: true, hasPolicy: false, source: null };
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create GitHub repository" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect existing repository" }),
  );
  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: "example/policies" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Repository")).toHaveValue("example/policies");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
