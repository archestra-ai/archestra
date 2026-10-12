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

test("links an existing repository whose policy lives elsewhere through Advanced", async () => {
  state = {
    validationDirectory: "",
    enabled: true,
    hasPolicy: false,
    source: null,
  };
  const appId = "11111111-1111-4111-8111-111111111111";
  const github = "http://localhost:9000/api/openappa/github-app";
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
    http.get(`${github}/pending`, () => HttpResponse.json(null)),
    http.get(`${github}/repository`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      return HttpResponse.json({
        status:
          query.get("ref") === "prod" &&
          query.get("path") === "policy/appa.toml"
            ? "policy"
            : "other",
      });
    }),
    http.get(`${github}/accounts`, () =>
      HttpResponse.json([
        { id: appId, account: "example", canAccessRepo: true },
      ]),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      expect(await request.json()).toEqual({
        owner: "example",
        name: "policies",
        githubAppConfigId: appId,
        interval: "1h",
        existing: true,
        ref: "prod",
        path: "policy/appa.toml",
      });
      state = {
        validationDirectory: "",
        enabled: true,
        hasPolicy: false,
        source: {
          ...source,
          ref: "prod",
          path: "policy/appa.toml",
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
  fireEvent.change(screen.getByLabelText("Owner"), {
    target: { value: "example" },
  });
  fireEvent.change(screen.getByLabelText("Repository name"), {
    target: { value: "policies" },
  });
  expect(
    await screen.findByText(/has no appa.toml/, {}, { timeout: 3000 }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("Branch"), {
    target: { value: "prod" },
  });
  fireEvent.change(screen.getByLabelText("Policy file"), {
    target: { value: "policy/appa.toml" },
  });
  expect(
    await screen.findByText(
      /already has policy\/appa.toml/,
      {},
      { timeout: 3000 },
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(
    await screen.findByText("1 of 1 can reach example/policies."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  expect(await screen.findByText("Waiting for the first sync")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("connects a template copy through an App that can reach it and waits on the initial merge in the dialog", async () => {
  state = {
    validationDirectory: "traces",
    enabled: true,
    hasPolicy: true,
    source: null,
  };
  const appId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  const github = "http://localhost:9000/api/openappa/github-app";
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json(
        [
          [appId, "Policy App"],
          [otherId, "Other App"],
        ].map(([id, name]) => ({
          id,
          name,
          kind: "github_app",
          allowOrganization: true,
          organizationConfigured: true,
        })),
      ),
    ),
    http.get(`${github}/pending`, () => HttpResponse.json(null)),
    http.get(`${github}/repository`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("repo")).toBe(
        "example/openappa-policy",
      );
      return HttpResponse.json({ status: "template" });
    }),
    http.get(`${github}/accounts`, () =>
      HttpResponse.json([
        { id: appId, account: "example", canAccessRepo: true },
        { id: otherId, account: "elsewhere", canAccessRepo: false },
      ]),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      expect(await request.json()).toEqual({
        owner: "example",
        name: "openappa-policy",
        githubAppConfigId: appId,
        interval: "1h",
        existing: true,
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
  fireEvent.change(screen.getByLabelText("Owner"), {
    target: { value: "example" },
  });
  // The template copy already exists, so nothing is created on GitHub.
  expect(
    await screen.findByText(
      /private copy of the OpenAPPA template/,
      {},
      { timeout: 3000 },
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Create on GitHub" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(
    await screen.findByText("1 of 2 can reach example/openappa-policy."),
  );
  // An App without access to the repository cannot be chosen.
  expect(screen.getByRole("radio", { name: /Other App/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  expect(
    await screen.findByRole("link", { name: /example\/openappa-policy/ }),
  ).toBeVisible();
  expect(
    await screen.findByRole("link", { name: "Review and merge PR" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/openappa-policy/pull/7",
  );
  // The dialog stays open on the pull request instead of closing.
  expect(screen.getByText("Finish setup in GitHub")).toBeVisible();
  server.use(
    http.patch(url, async ({ request }) => {
      expect(await request.json()).toEqual({ action: "sync" });
      state = {
        ...state,
        source: {
          ...source,
          repo: "example/openappa-policy",
          sourceCommit: "b".repeat(40),
          setupPullRequestNumber: null,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check if merged" }));
  expect(await screen.findByText("Setup finished")).toBeVisible();
  expect(screen.getByText("Merged")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Check if merged" }),
  ).not.toBeInTheDocument();
  expect(toast.success).toHaveBeenCalledWith(
    "Initial policy merged. Policy synced from GitHub.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByText("Setup finished")).not.toBeInTheDocument(),
  );
});

test("blocks a repository name that exists without a policy", async () => {
  state = {
    validationDirectory: "",
    enabled: true,
    hasPolicy: true,
    source: null,
  };
  const github = "http://localhost:9000/api/openappa/github-app";
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
    http.get(`${github}/pending`, () => HttpResponse.json(null)),
    http.get(`${github}/repository`, () =>
      HttpResponse.json({ status: "other" }),
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create GitHub repository" }),
  );
  fireEvent.change(screen.getByLabelText("Owner"), {
    target: { value: "example" },
  });
  expect(
    await screen.findByText(/has no appa.toml/, {}, { timeout: 3000 }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("asks before discarding a GitHub source draft", async () => {
  state = {
    validationDirectory: "",
    enabled: true,
    hasPolicy: false,
    source: null,
  };
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
  );
  const close = vi.fn();
  show(<OpenAppaSourceForm source={null} onOpenChange={close} />);
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
  expect(close).toHaveBeenCalledWith(false);
});

test("leaves the validation folder and sync interval alone, and stays open on server rejection", async () => {
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
  );
  let saved: Record<string, unknown> | undefined;
  let reject = true;
  server.use(
    http.put(url, async ({ request }) => {
      saved = (await request.json()) as Record<string, unknown>;
      if (reject)
        return HttpResponse.json(
          { error: { message: "appa.toml not found", type: "api_error" } },
          { status: 404 },
        );
      return HttpResponse.json(state);
    }),
  );
  const close = vi.fn();
  show(
    <OpenAppaSourceForm
      source={{ ...source, interval: "1d" }}
      onOpenChange={close}
    />,
  );
  expect(
    screen.queryByLabelText("Validation directory (optional)"),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Sync frequency")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  expect(await screen.findByText("appa.toml not found")).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  expect(saved).not.toHaveProperty("validationDirectory");
  expect(saved?.interval).toBe("1d");
  reject = false;
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
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
