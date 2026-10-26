import {
  archestraApiClient,
  type archestraApiTypes,
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { runtimeCredentialsQueryKey } from "@/lib/runtime-credentials.query";
import {
  GitHubActionsAccessSection,
  gitHubActionsAccessError,
} from "./github-actions-access-section";

vi.mock("@/lib/hooks/use-app-name");

const API_ORIGIN = "http://localhost:9000";
const WORKFLOW =
  "acme/review-workflows/.github/workflows/review.yml@refs/heads/main";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useAppName).mockReturnValue("Archestra");
  server.use(
    http.get(`${API_ORIGIN}/api/credentials`, () =>
      HttpResponse.json([
        credential({ key: "review-app", name: "Code Review App" }),
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
  it("turns on with the organization's only GitHub.com App selected", async () => {
    const user = userEvent.setup();
    const { queryClient, onChange } = renderSection(null);
    await waitFor(() =>
      expect(
        queryClient.getQueryData(runtimeCredentialsQueryKey),
      ).toBeDefined(),
    );

    await user.click(
      screen.getByRole("switch", { name: "Accept GitHub Actions tokens" }),
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Code Review App");
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
    expect(screen.getByText("Enter a repository as owner/name")).toBeVisible();
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

    const saved = onChange.mock.lastCall?.[0];
    expect(saved).toEqual({
      githubAppCredentialKey: "review-app",
      repositories: ["acme/widgets"],
      workflows: [WORKFLOW],
    });
    expect(GitHubActionsAccessSchema.safeParse(saved).success).toBe(true);
    expect(gitHubActionsAccessError(saved)).toBeNull();
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
