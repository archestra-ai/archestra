import {
  archestraApiClient,
  type archestraApiTypes,
  GITHUB_ACTIONS_REPOSITORY_MESSAGE,
  type GitHubActionsAccess,
  GitHubActionsAccessSchema,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
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
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  GitHubActionsAccessSection,
  gitHubActionsAccessError,
} from "./github-actions-access-section";

vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/auth/auth.query");

const API_ORIGIN = "http://localhost:9000";
const WORKFLOW =
  "acme/review-workflows/.github/workflows/review.yml@refs/heads/main";
const REVIEW_APP_ID = "00000000-0000-4000-8000-000000000001";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useAppName).mockReturnValue("Archestra");
  // The editor may use the review App, and no credential beyond it.
  allowCredentialUse([REVIEW_APP_ID]);
  server.use(
    http.get(`${API_ORIGIN}/api/credentials`, () =>
      HttpResponse.json([
        credential({
          id: REVIEW_APP_ID,
          key: "review-app",
          name: "Code Review App",
        }),
        // Not usable: GitHub Actions tokens come from GitHub.com.
        credential({
          key: "enterprise-app",
          name: "Enterprise App",
          githubUrl: "https://github.example.com/api/v3",
        }),
        credential({ key: "a-token", name: "A token", kind: "secret" }),
      ]),
    ),
  );
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("GitHubActionsAccessSection", () => {
  it("turns on with the only GitHub.com App the editor may use selected", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection(null);
    const toggle = screen.getByRole("switch", {
      name: "Accept GitHub Actions tokens",
    });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    expect(
      screen.getByRole("combobox", { name: "GitHub App" }),
    ).toHaveTextContent("Code Review App");
    expect(onChange).toHaveBeenLastCalledWith({
      githubAppCredentialKey: "review-app",
      repositories: [],
      workflows: [],
    });
  });

  it("builds a setting the API accepts and refuses malformed entries", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection({
      githubAppCredentialKey: "review-app",
      repositories: [],
      workflows: [],
    });
    const repositories = screen.getByLabelText("Repositories");
    const workflows = screen.getByLabelText("Trusted workflows");

    await user.type(repositories, "widgets{Enter}");
    expect(screen.getByText(GITHUB_ACTIONS_REPOSITORY_MESSAGE)).toBeVisible();
    await user.clear(repositories);
    await user.type(repositories, "acme/widgets{Enter}");
    await user.type(repositories, "ACME/Widgets{Enter}");
    expect(screen.getByText("ACME/Widgets is already listed")).toBeVisible();

    // A pull request's own ref would let the pull request rewrite the workflow.
    await user.type(
      workflows,
      "acme/widgets/.github/workflows/review.yml@refs/pull/42/merge{Enter}",
    );
    expect(
      screen.getByText(/Enter a workflow as owner\/repo/, {
        selector: "[role=alert]",
      }),
    ).toBeVisible();
    await user.clear(workflows);
    await user.type(workflows, `${WORKFLOW}{Enter}`);

    const saved = onChange.mock.lastCall?.[0] ?? null;
    expect(saved).toEqual({
      githubAppCredentialKey: "review-app",
      repositories: ["acme/widgets"],
      workflows: [WORKFLOW],
    });
    expect(GitHubActionsAccessSchema.safeParse(saved).success).toBe(true);
    expect(gitHubActionsAccessError(saved)).toBeNull();
  });

  it("takes owner/* and says when it already covers a listed repository", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection({
      githubAppCredentialKey: "review-app",
      repositories: ["acme/widgets"],
      workflows: [WORKFLOW],
    });

    await user.type(screen.getByLabelText("Repositories"), "acme/*{Enter}");

    expect(onChange.mock.lastCall?.[0]?.repositories).toEqual([
      "acme/widgets",
      "acme/*",
    ]);
    expect(
      screen.getByText(
        "An owner/* entry already covers that owner's repositories",
        { selector: "[role=alert]" },
      ),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Remove acme/widgets" }),
    );

    expect(onChange.mock.lastCall?.[0]?.repositories).toEqual(["acme/*"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("acts as the author unless whoever started the run is picked", async () => {
    // Radix Select needs these, which jsdom lacks.
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    Element.prototype.scrollIntoView = vi.fn();
    const user = userEvent.setup();
    const { onChange } = renderSection({
      githubAppCredentialKey: "review-app",
      repositories: ["acme/widgets"],
      workflows: [WORKFLOW],
    });
    const actAs = screen.getByRole("combobox", { name: "Runs act as" });
    expect(actAs).toHaveTextContent("The pull request's author");

    await user.click(actAs);
    await user.click(
      screen.getByRole("option", { name: "Whoever started the run" }),
    );
    const saved = onChange.mock.lastCall?.[0] ?? null;
    expect(saved).toMatchObject({ actAs: "actor" });
    expect(GitHubActionsAccessSchema.safeParse(saved).success).toBe(true);

    await user.click(screen.getByRole("combobox", { name: "Runs act as" }));
    await user.click(
      screen.getByRole("option", { name: "The pull request's author" }),
    );
    expect(onChange.mock.lastCall?.[0]?.actAs).toBeUndefined();
  });

  it("gives runs Contents write only when review threads are resolved", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection({
      githubAppCredentialKey: "review-app",
      repositories: ["acme/widgets"],
      workflows: [WORKFLOW],
    });
    const toggle = screen.getByRole("switch", {
      name: "Resolve review threads",
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      resolveReviewThreads: true,
    });

    await user.click(toggle);
    expect(onChange.mock.lastCall?.[0]?.resolveReviewThreads).toBeUndefined();
  });

  it("says what is still missing before the setting can be saved", () => {
    renderSection({
      githubAppCredentialKey: "review-app",
      repositories: [],
      workflows: [WORKFLOW],
    });

    expect(
      screen.getByText("Add at least one repository", {
        selector: "[role=alert]",
      }),
    ).toBeVisible();
  });

  it.each([
    ["holds no use grant on the App", () => allowCredentialUse([])],
    [
      "cannot list credentials",
      () =>
        server.use(
          http.get(`${API_ORIGIN}/api/credentials`, () =>
            HttpResponse.json(
              {
                error: {
                  message: "Forbidden",
                  type: "api_authorization_error",
                },
              },
              { status: 403 },
            ),
          ),
        ),
    ],
  ])("keeps it off for an editor who %s", async (_case, arrange) => {
    arrange();
    renderSection(null);

    expect(
      await screen.findByText(
        "You need permission to use a GitHub App credential to turn this on.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Accept GitHub Actions tokens" }),
    ).toBeDisabled();
    expect(screen.queryByText(/No GitHub App for GitHub.com yet/)).toBeNull();
  });

  it("turns the exchange off", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection({
      githubAppCredentialKey: "review-app",
      repositories: ["acme/widgets"],
      workflows: [WORKFLOW],
    });

    await user.click(
      screen.getByRole("switch", { name: "Accept GitHub Actions tokens" }),
    );

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByLabelText("Repositories")).not.toBeInTheDocument();
  });
});

/** `use` grants on these credentials, and no wildcard grant. */
function allowCredentialUse(credentialIds: string[]) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: credentialIds.map((scope) => ({
      resource: "credential",
      action: "use",
      scope,
    })),
  } as unknown as ReturnType<typeof useScopedCapabilities>);
}

function renderSection(initial: GitHubActionsAccess | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onChange = vi.fn<(value: GitHubActionsAccess | null) => void>();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <GitHubActionsAccessSection
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return { queryClient, onChange };
}

function credential(
  overrides: Partial<
    archestraApiTypes.ListRuntimeCredentialsResponses["200"][number]
  >,
): archestraApiTypes.ListRuntimeCredentialsResponses["200"][number] {
  return {
    id: crypto.randomUUID(),
    kind: "github_app",
    githubUrl: "https://api.github.com",
    gitlabUrl: null,
    appId: "123",
    installationId: "456",
    githubClientId: "client",
    githubAppCredentialKey: null,
    key: "credential",
    name: "Credential",
    description: "",
    icon: null,
    builtIn: false,
    allowPersonal: false,
    allowOrganization: true,
    personalConfigured: false,
    organizationConfigured: true,
    ...overrides,
  };
}
