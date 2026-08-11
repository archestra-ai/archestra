import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import {
  useAssignableTeams,
  useMyTeams,
  useTeams,
} from "@/lib/teams/team.query";
import NewMcpCatalogItemPage from "./page";

vi.mock("next/navigation");

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: false,
    },
  },
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: vi.fn(() => ({
    data: { environments: [], defaultAssignedCatalogCount: 0 },
  })),
}));

vi.mock("@/lib/auth/identity-provider-read.query", () => ({
  useIdentityProviders: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/teams/team.query");

// Keep the real error-code helpers (the page's inline-error mapping depends on
// them matching the backend), mock only the hooks.
vi.mock("@/lib/mcp/internal-mcp-catalog.query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/mcp/internal-mcp-catalog.query")
    >();
  return {
    ...actual,
    useInternalMcpCatalog: vi.fn(),
    useCreateInternalMcpCatalogItem: vi.fn(),
    useK8sImagePullSecrets: vi.fn(() => ({ data: [] })),
  };
});

vi.mock("@/lib/secrets.query", () => ({
  useGetSecret: vi.fn(() => ({ data: null })),
}));

vi.mock("@/lib/docs/docs", () => ({
  getVisibleDocsUrl: vi.fn(() => "https://docs.example.com"),
  getFrontendDocsUrl: vi.fn(() => "https://docs.example.com/mcp-auth"),
}));

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <div data-testid="agent-icon-picker" />,
}));

vi.mock("@/components/agent-labels", () => ({
  ProfileLabels: () => <div data-testid="profile-labels" />,
}));

vi.mock("@/components/environment-variables-form-field", () => ({
  EnvironmentVariablesFormField: () => (
    <div data-testid="environment-variables-form-field" />
  ),
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: () => <div data-testid="visibility-selector" />,
}));

// Minimal remote catalog item the ?clone= param resolves to.
const cloneSource = {
  id: "clone-source-id",
  name: "remote-src",
  description: "A remote server",
  icon: null,
  serverType: "remote",
  serverUrl: "https://api.example.com/mcp",
  oauthConfig: null,
  userConfig: null,
  enterpriseManagedConfig: null,
  localConfig: null,
  deploymentSpecYaml: null,
  labels: [],
  scope: "personal",
  teams: [],
  environmentId: null,
} as unknown as NonNullable<
  ReturnType<typeof useInternalMcpCatalog>["data"]
>[number];

describe("NewMcpCatalogItemPage clone flow", () => {
  const push = vi.fn();
  const mutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
      typeof useRouter
    >);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clone=clone-source-id") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [cloneSource],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useCreateInternalMcpCatalogItem).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateInternalMcpCatalogItem>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { onlineMcpCatalogEnabled: false },
      isPending: false,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useFeature).mockImplementation((feature: string) => {
      if (feature === "mcpServerBaseImage") return "";
      if (feature === "orchestratorK8sRuntime") return true;
      if (feature === "byosEnabled") return false;
      return undefined;
    });
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
      namespace: null,
      description: null,
      networkPolicy: null,
      restricted: false,
    } as ReturnType<typeof useDefaultEnvironment>);
    vi.mocked(useTeams).mockReturnValue({ data: [] } as unknown as ReturnType<
      typeof useTeams
    >);
    vi.mocked(useMyTeams).mockReturnValue({ data: [] } as unknown as ReturnType<
      typeof useMyTeams
    >);
    vi.mocked(useAssignableTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAssignableTeams>);
    vi.mocked(useAppName).mockReturnValue("Archestra");
  });

  it("keeps user edits across parent re-renders instead of resetting to the clone values", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NewMcpCatalogItemPage />);

    const nameInput = await screen.findByDisplayValue("remote-src-copy");
    await user.clear(nameInput);
    await user.type(nameInput, "my-edited-name");

    // A parent re-render (e.g. the create mutation flipping to pending) must
    // not rebuild the pre-fill values and wipe the user's edits.
    rerender(<NewMcpCatalogItemPage />);

    expect(screen.getByDisplayValue("my-edited-name")).toBeInTheDocument();
  });

  it("submits the edited values and shows a network-policy rejection inline instead of silently dropping it", async () => {
    mutate.mockImplementation((_data, opts) => {
      const error = new Error(
        "The remote MCP server host is not permitted by the environment's network egress policy.",
      ) as Error & { internalCode?: string };
      error.internalCode = "remote_server_url_not_allowed";
      // TanStack Query always delivers mutation callbacks asynchronously —
      // a synchronous call here would land before the form's post-submit
      // baseline reset and get wiped, which real mutations never hit.
      setTimeout(() => opts?.onError?.(error), 0);
    });

    const user = userEvent.setup();
    render(<NewMcpCatalogItemPage />);

    const nameInput = await screen.findByDisplayValue("remote-src-copy");
    await user.clear(nameInput);
    await user.type(nameInput, "my-edited-name");

    await user.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledTimes(1);
    });
    expect(mutate.mock.calls[0][0]).toMatchObject({
      name: "my-edited-name",
      clonedFrom: "clone-source-id",
    });

    // The rejection surfaces inline on the Server URL field...
    expect(
      await screen.findByText(
        "The remote MCP server host is not permitted by the environment's network egress policy.",
      ),
    ).toBeInTheDocument();
    // ...the user's edits survive the failed submit, and no navigation happens.
    expect(screen.getByDisplayValue("my-edited-name")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
