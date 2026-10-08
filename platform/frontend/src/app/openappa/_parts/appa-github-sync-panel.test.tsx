import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
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
import {
  AppaGithubSyncPanel,
  OpenAppaSourceForm,
} from "./appa-github-sync-panel";

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
  setupPullRequestNumber: null,
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
  state = {
    validationDirectory: "traces",
    enabled: true,
    hasPolicy: true,
    source,
  };
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
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  server.use(
    http.patch(url, async ({ request }) => {
      await pending;
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
  expect(
    await screen.findByRole("button", { name: "Syncing…" }),
  ).toBeDisabled();
  finish();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub returned HTTP 403",
  );
  expect(screen.getByRole("link", { name: /example\/policies/ })).toBeVisible();
  expect(toast.success).not.toHaveBeenCalled();
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
    screen.getByText(/Your last synced policy stays active/),
  ).toBeVisible();
});

test("read-only users see status without mutation controls", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          permissions.organizationSettings?.every(
            (action) => action === "read",
          ) ?? false,
      }) as ReturnType<typeof useHasPermissions>,
  );
  show();
  expect(await screen.findByText("Connected")).toBeVisible();
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
  expect(await screen.findByText("Connected")).toBeVisible();
});

test("connects an existing repository with an App and renders the saved source", async () => {
  state = {
    validationDirectory: "",
    enabled: true,
    hasPolicy: false,
    source: null,
  };
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
    http.put(url, async ({ request }) => {
      expect(await request.json()).toEqual({
        repo: "example/policies",
        ref: null,
        path: "appa.toml",
        validationDirectory: "",
        interval: "1h",
        githubPatId: null,
        githubAppConfigId: appId,
      });
      state = {
        validationDirectory: "traces",
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
  fireEvent.click(screen.getByRole("combobox", { name: "GitHub credential" }));
  fireEvent.click(await screen.findByRole("option", { name: "Policy App" }));
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  expect(await screen.findByText("Waiting for the first sync")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("creates a repository with a connected App and shows the initial merge link", async () => {
  state = {
    validationDirectory: "traces",
    enabled: true,
    hasPolicy: true,
    source: null,
  };
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
        name: "openappa-policy",
        githubAppConfigId: appId,
        interval: "1h",
      });
      state = {
        validationDirectory: "traces",
        enabled: true,
        hasPolicy: true,
        source: {
          ...source,
          repo: "example/openappa-policy",
          sourceCommit: null,
          setupPullRequestNumber: 7,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create GitHub repository" }),
  );
  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: "example/openappa-policy" },
  });
  expect(
    screen.getByRole("button", { name: "Create and sync" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("combobox", { name: "Connected GitHub App" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Policy App" }));
  fireEvent.click(screen.getByRole("button", { name: "Create and sync" }));
  expect(
    await screen.findByRole("link", { name: /example\/openappa-policy/ }),
  ).toBeVisible();
  expect(
    await screen.findByRole("link", { name: "Review and merge PR" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/openappa-policy/pull/7",
  );
  expect(screen.getByText("Awaiting initial merge")).toBeVisible();
});

test("asks before discarding a GitHub source draft", async () => {
  state = {
    validationDirectory: "",
    enabled: true,
    hasPolicy: false,
    source: null,
  };
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

test("keeps an invalid folder draft open on server rejection and saves an empty folder to disable validation", async () => {
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
  );
  let saved: Record<string, unknown> | undefined;
  server.use(
    http.put(url, async ({ request }) => {
      saved = (await request.json()) as Record<string, unknown>;
      if (saved.validationDirectory === "missing")
        return HttpResponse.json(
          {
            error: {
              message: "Validation directory not found",
              type: "api_error",
            },
          },
          { status: 404 },
        );
      return HttpResponse.json({ ...state, validationDirectory: "" });
    }),
  );
  const close = vi.fn();
  show(
    <OpenAppaSourceForm
      source={source}
      validationDirectory="traces"
      onOpenChange={close}
    />,
  );
  const input = screen.getByLabelText("Validation directory (optional)");
  expect(input).toHaveValue("traces");
  fireEvent.change(input, { target: { value: "missing" } });
  expect(screen.getByRole("link", { name: "Open in GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/tree/main/missing",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  expect(
    await screen.findByText("Validation directory not found"),
  ).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  expect(input).toHaveValue("missing");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(saved?.validationDirectory).toBe("");
});

test("keeps the merge link after reload and removes it once initial sync completes", async () => {
  state = {
    ...state,
    source: { ...source, setupPullRequestNumber: 7, sourceCommit: null },
  };
  server.use(
    http.patch(url, () => {
      state = { ...state, source };
      return HttpResponse.json(state);
    }),
  );
  show();
  expect(
    await screen.findByRole("link", { name: "Review and merge PR" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/7");
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "Review and merge PR" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Connected")).toBeVisible();
});
