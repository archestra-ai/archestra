import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { makeSession } from "@/mocks/data/auth";
import { makeConfig } from "@/mocks/data/config";
import { AgentRuntimeCredentialsDeepLink } from "./agent-runtime-credentials-dialog";

vi.mock("next/navigation");
vi.mock("sonner");

const origin = "http://localhost:9000";
const declarations = [
  {
    key: "GITHUB_TOKEN",
    credentialId: "github",
    label: "GitHub token",
    scope: "per_user" as const,
    required: true,
  },
  {
    key: "SERVICE_TOKEN",
    label: "Service token",
    scope: "per_user" as const,
    required: true,
  },
  {
    key: "OPTIONAL_TOKEN",
    label: "Optional token",
    scope: "per_user" as const,
    required: false,
  },
];
const server = setupServer();
let configured: string[];
let writes: Array<{ key: string; value: string }>;
let failKey: string | null;
let permissions: Record<string, string[]>;
let queryClient: QueryClient;
const replace = vi.fn();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  server.resetHandlers();
  queryClient.clear();
  window.history.replaceState(null, "", "/");
});
beforeEach(() => {
  configured = [];
  writes = [];
  failKey = null;
  permissions = { agent: ["read"], agentSettings: [] };
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["auth", "session"], makeSession());
  archestraApiClient.setConfig({ baseUrl: origin });
  window.history.replaceState(
    null,
    "",
    "/agents/agent-1?section=advanced&setup=credentials",
  );
  vi.mocked(usePathname).mockReturnValue("/agents/agent-1");
  vi.mocked(useSearchParams).mockImplementation(
    () =>
      new URLSearchParams(window.location.search) as ReturnType<
        typeof useSearchParams
      >,
  );
  vi.mocked(useRouter).mockReturnValue({ replace } as unknown as ReturnType<
    typeof useRouter
  >);
  server.use(
    http.get("http://localhost:3000/api/auth/get-session", () =>
      HttpResponse.json(makeSession()),
    ),
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json(permissions),
    ),
    http.get(`${origin}/api/config`, () => HttpResponse.json(makeConfig())),
    http.get(`${origin}/api/runtime-credentials`, () =>
      HttpResponse.json([
        {
          key: "github",
          name: "GitHub",
          description: "Repository access",
          icon: null,
          builtIn: true,
          allowPersonal: true,
          allowOrganization: false,
          personalConfigured: configured.includes("GITHUB_TOKEN"),
          organizationConfigured: false,
        },
      ]),
    ),
    http.get(`${origin}/api/agents/agent-1/runtime/preflight`, () =>
      HttpResponse.json({
        configured,
        missing: declarations.filter(
          ({ key, required }) => required && !configured.includes(key),
        ),
        misconfigured: [],
        incompatible: null,
        ready: configured.length === 2,
      }),
    ),
    http.put(
      `${origin}/api/agents/agent-1/runtime/credentials/:key`,
      async ({ params, request }) => {
        const key = String(params.key);
        const { value } = (await request.json()) as { value: string };
        writes.push({ key, value });
        if (key === failKey)
          return HttpResponse.json(
            {
              error: {
                message: "Connection unavailable",
                type: "api_internal_server_error",
              },
            },
            { status: 500 },
          );
        configured.push(key);
        return HttpResponse.json({ configured: true });
      },
    ),
  );
});

function show(
  props: Partial<Parameters<typeof AgentRuntimeCredentialsDeepLink>[0]> = {},
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentRuntimeCredentialsDeepLink
        agentId="agent-1"
        declarations={declarations}
        canEditAgent={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("credential setup deep links", () => {
  it.each([
    "?section=advanced&setup=credentials",
    "?tab=overview#runtime-credentials",
  ])("prompts for every missing credential from %s and saves both", async (query) => {
    window.history.replaceState(null, "", `/agents/agent-1${query}`);
    const user = userEvent.setup();
    show();
    await user.type(
      await screen.findByLabelText("GitHub token"),
      "example-github-secret",
    );
    await user.type(
      screen.getByLabelText("Service token"),
      "example-service-secret",
    );
    expect(screen.queryByLabelText("Optional token")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    expect(
      await screen.findByText(/All required credentials are configured/),
    ).toBeVisible();
    expect(writes).toEqual(
      expect.arrayContaining([
        { key: "GITHUB_TOKEN", value: "example-github-secret" },
        { key: "SERVICE_TOKEN", value: "example-service-secret" },
      ]),
    );
    expect(writes).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(replace).toHaveBeenCalledWith(
      query.includes("section")
        ? "/agents/agent-1?section=advanced"
        : "/agents/agent-1",
      { scroll: false },
    );
  });

  it("only retries failed credentials after a partial save", async () => {
    failKey = "SERVICE_TOKEN";
    const user = userEvent.setup();
    show();
    await user.type(
      await screen.findByLabelText("GitHub token"),
      "example-github-secret",
    );
    await user.type(
      screen.getByLabelText("Service token"),
      "example-service-secret",
    );
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    await screen.findByText("Could not save this credential. Try again.");
    expect(screen.queryByLabelText("GitHub token")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Service token")).toHaveValue(
      "example-service-secret",
    );
    failKey = null;
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    await screen.findByText(/All required credentials are configured/);
    expect(writes.filter(({ key }) => key === "GITHUB_TOKEN")).toHaveLength(1);
    expect(writes.filter(({ key }) => key === "SERVICE_TOKEN")).toHaveLength(2);
  });

  it("does not request already configured or optional credentials", async () => {
    configured = ["GITHUB_TOKEN"];
    show();
    await screen.findByLabelText("Service token");
    expect(screen.queryByLabelText("GitHub token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Optional token")).not.toBeInTheDocument();
  });

  it("keeps unavailable shared credentials visible while allowing a reader to save personal credentials", async () => {
    const shared = {
      key: "SHARED_TOKEN",
      credentialId: "shared",
      label: "Organization token",
      scope: "shared" as const,
      required: true,
    };
    server.use(
      http.get(`${origin}/api/agents/agent-1/runtime/preflight`, () =>
        HttpResponse.json({
          configured,
          missing: declarations.filter(
            ({ required, key }) => required && !configured.includes(key),
          ),
          misconfigured: [shared],
          incompatible: null,
          ready: false,
        }),
      ),
    );
    const user = userEvent.setup();
    show({ declarations: [...declarations, shared] });
    await user.type(
      await screen.findByLabelText("GitHub token"),
      "example-github-secret",
    );
    await user.type(
      screen.getByLabelText("Service token"),
      "example-service-secret",
    );
    expect(
      screen.getByText(
        "An administrator must configure this organization credential.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save credentials" }),
      ).not.toBeInTheDocument(),
    );
    expect(writes).toHaveLength(2);
    expect(
      screen.queryByText(/All required credentials are configured/),
    ).not.toBeInTheDocument();
  });

  it("retries a preflight failure instead of claiming credentials are configured", async () => {
    server.use(
      http.get(
        `${origin}/api/agents/agent-1/runtime/preflight`,
        () =>
          HttpResponse.json(
            {
              error: {
                message: "Unavailable",
                type: "api_internal_server_error",
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText("Could not load runtime credentials");
    expect(
      screen.queryByText(/All required credentials are configured/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("GitHub token")).toBeVisible();
  });

  it("requires a value for every editable missing credential", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByLabelText("GitHub token");
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    expect(await screen.findAllByText("Secret value is required")).toHaveLength(
      2,
    );
    expect(writes).toEqual([]);
  });

  it("uses Vault selection for every credential when external secrets are enabled", async () => {
    server.use(
      http.get(`${origin}/api/config`, () =>
        HttpResponse.json(makeConfig({ features: { byosEnabled: true } })),
      ),
    );
    show();
    expect(
      await screen.findByRole("button", { name: "GitHub token" }),
    ).toHaveTextContent("Select Vault secret");
    expect(
      screen.getByRole("button", { name: "Service token" }),
    ).toHaveTextContent("Select Vault secret");
    expect(
      screen.queryByPlaceholderText("Paste secret"),
    ).not.toBeInTheDocument();
  });

  it("lets an administrator configure a missing organization connection", async () => {
    permissions = { agent: ["read"], agentSettings: ["update"] };
    const shared = { ...declarations[0], scope: "shared" as const };
    server.use(
      http.get(`${origin}/api/agents/agent-1/runtime/preflight`, () =>
        HttpResponse.json({
          configured,
          missing: [],
          misconfigured: configured.length ? [] : [shared],
          incompatible: null,
          ready: configured.length > 0,
        }),
      ),
    );
    const user = userEvent.setup();
    show({ declarations: [shared] });
    await user.type(
      await screen.findByLabelText("GitHub token"),
      "example-organization-secret",
    );
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    await screen.findByText(/All required credentials are configured/);
    expect(writes).toEqual([
      { key: "GITHUB_TOKEN", value: "example-organization-secret" },
    ]);
  });

  it("saves agent-specific shared secrets without overlapping updates to their shared bag", async () => {
    const shared = declarations.slice(0, 2).map((credential) => ({
      ...credential,
      credentialId: undefined,
      scope: "shared" as const,
    }));
    let bag: Record<string, string> = {};
    server.use(
      http.get(`${origin}/api/agents/agent-1/runtime/preflight`, () =>
        HttpResponse.json({
          configured: Object.keys(bag),
          missing: [],
          misconfigured: shared.filter(({ key }) => !bag[key]),
          incompatible: null,
          ready: Object.keys(bag).length === 2,
        }),
      ),
      http.put(
        `${origin}/api/agents/agent-1/runtime/credentials/:key`,
        async ({ params, request }) => {
          const snapshot = { ...bag };
          const { value } = (await request.json()) as { value: string };
          await delay(20);
          bag = { ...snapshot, [String(params.key)]: value };
          return HttpResponse.json({ configured: true });
        },
      ),
    );
    const user = userEvent.setup();
    show({ declarations: shared, canEditAgent: true });
    await user.type(
      await screen.findByLabelText("GitHub token"),
      "example-github-secret",
    );
    await user.type(
      screen.getByLabelText("Service token"),
      "example-service-secret",
    );
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    await screen.findByText(/All required credentials are configured/);
    expect(bag).toEqual({
      GITHUB_TOKEN: "example-github-secret",
      SERVICE_TOKEN: "example-service-secret",
    });
  });

  it("shows full multiline definition and agent-specific instructions for every missing credential", async () => {
    const githubDescription =
      "Create a token for the example repository.\nChoose the repository permissions required by your workflow.\nKeep the token private and paste it below.";
    const claudeDescription =
      "Run claude setup-token on your own machine.\nComplete the sign-in flow in your browser.\nCopy the resulting subscription token and paste it below.";
    server.use(
      http.get(`${origin}/api/runtime-credentials`, () =>
        HttpResponse.json([
          {
            key: "github",
            name: "GitHub",
            description: githubDescription,
            icon: null,
          },
          {
            key: "claude-code",
            name: "Claude Code",
            description: claudeDescription,
            icon: null,
          },
        ]),
      ),
    );
    const instructions =
      "This Agent needs access to the example project and its dependencies.";
    show({
      declarations: declarations.map((credential) => ({
        ...credential,
        credentialId:
          credential.key === "GITHUB_TOKEN" ? "github" : "claude-code",
        description: instructions,
      })),
    });
    await screen.findByLabelText("GitHub token");
    expect(
      screen.getByText(githubDescription, { normalizer: (text) => text }),
    ).toBeVisible();
    expect(
      screen.getByText(claudeDescription, { normalizer: (text) => text }),
    ).toBeVisible();
    expect(screen.getAllByText(instructions)).toHaveLength(2);
  });

  it("does not open for ordinary agent navigation", () => {
    window.history.replaceState(null, "", "/agents/agent-1?section=advanced");
    show();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
