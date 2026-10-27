import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import {
  useCheckCopilotGithubOrganization,
  useConnectCopilotGithubAppCredential,
  useConnectExistingCopilotGithubApp,
  useDiscardCopilotGithubApp,
  useInstallCopilotGithubApp,
  usePendingCopilotGithubApp,
  useStartCopilotGithubApp,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import {
  CopilotOrganizationConnectDialog,
  hasClaudeOrGemini,
} from "./copilot-organization-connect-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/github-copilot-app.query", () => ({
  useCheckCopilotGithubOrganization: vi.fn(),
  useConnectCopilotGithubAppCredential: vi.fn(),
  useConnectExistingCopilotGithubApp: vi.fn(),
  useDiscardCopilotGithubApp: vi.fn(),
  useInstallCopilotGithubApp: vi.fn(),
  usePendingCopilotGithubApp: vi.fn(),
  useStartCopilotGithubApp: vi.fn(),
  useValidateExistingCopilotGithubApp: vi.fn(),
}));
vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: vi.fn(),
}));
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => <div>Access picker</div>,
}));

/** A mutation double: `mutate` calls `onSuccess` with `result`. */
function mutation(result?: unknown, extra?: Record<string, unknown>) {
  return {
    mutate: vi.fn(
      (_body: unknown, options?: { onSuccess?: (data: unknown) => void }) =>
        options?.onSuccess?.(result),
    ),
    reset: vi.fn(),
    isPending: false,
    error: null,
    data: undefined,
    ...extra,
  };
}

const connectedApp = {
  id: "cred-1",
  name: "My Org Copilot",
  icon: null,
  kind: "github_app",
  allowOrganization: true,
  organizationConfigured: true,
  githubUrl: "https://api.github.com",
};

const installed = {
  status: "installed",
  id: "key-1",
  organization: "my-org",
  modelIds: ["gpt-4o", "gpt-4.1"],
};

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("My App");
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: hasPermissions(
          { credential: ["read", "create"], llmProviderApiKey: ["create"] },
          permissions,
        ),
      }) as ReturnType<typeof useHasPermissions>,
  );
  vi.mocked(useRuntimeCredentials).mockReturnValue({
    data: [connectedApp],
    isPending: false,
  } as unknown as ReturnType<typeof useRuntimeCredentials>);
  vi.mocked(usePendingCopilotGithubApp).mockReturnValue({
    data: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePendingCopilotGithubApp>);
  vi.mocked(useCheckCopilotGithubOrganization).mockReturnValue(
    mutation({ organization: "my-org" }) as never,
  );
  for (const hook of [
    useStartCopilotGithubApp,
    useInstallCopilotGithubApp,
    useDiscardCopilotGithubApp,
    useConnectCopilotGithubAppCredential,
    useValidateExistingCopilotGithubApp,
    useConnectExistingCopilotGithubApp,
  ])
    vi.mocked(hook).mockReturnValue(mutation() as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function continueWithOrganization(value = "my-org") {
  const user = userEvent.setup();
  render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);
  await user.type(screen.getByLabelText("GitHub organization"), value);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

describe("CopilotOrganizationConnectDialog", () => {
  it("asks for the organization in one field, in the Guardrails stepper", async () => {
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    for (const label of ["Organization", "GitHub App", "Access"])
      expect(screen.getByText(label)).toBeInTheDocument();
    const field = screen.getByLabelText("GitHub organization");
    expect(field).toHaveAttribute(
      "placeholder",
      "my-org or https://github.com/my-org",
    );
    expect(field).toHaveAccessibleDescription(
      "Organization's GitHub handle or URL",
    );
    expect(
      screen.getByText("Read code, repositories, issues or members"),
    ).toBeInTheDocument();
  });

  it("shows the backend's organization error in place of the help line", async () => {
    vi.mocked(useCheckCopilotGithubOrganization).mockReturnValue({
      ...mutation(),
      mutate: vi.fn(),
      error: new Error(
        "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
      ),
    } as never);
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
    );
  });

  it("offers the organization's connected Apps and says when one lacks Copilot Requests", async () => {
    const fromCredential = mutation(undefined, {
      data: {
        status: "needs_permission",
        appName: "My Org Copilot",
        organization: "my-org",
        settingsUrl:
          "https://github.com/organizations/my-org/settings/apps/my-org-copilot",
      },
    });
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      fromCredential as never,
    );
    const user = await continueWithOrganization();

    expect(screen.getByText("1 connected to My App.")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));

    expect(fromCredential.mutate).toHaveBeenCalledWith(
      { credentialId: "cred-1", organization: "my-org" },
      expect.anything(),
    );
    expect(
      screen.getByText("My Org Copilot can't make Copilot requests yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add Copilot Requests (Read-only) in its settings; an owner of my-org approves the change.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open settings/ })).toHaveAttribute(
      "href",
      "https://github.com/organizations/my-org/settings/apps/my-org-copilot",
    );
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(fromCredential.mutate).toHaveBeenCalledTimes(2);
  });

  it("goes to Access once a picked App connects", async () => {
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      mutation(installed) as never,
    );
    const user = await continueWithOrganization();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));

    expect(screen.getByText("Connected. 2 models:")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No Claude or Gemini models. my-org's Copilot model policy may have them switched off.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });

  it("registers a new App with the shared manifest rows", async () => {
    const start = mutation(null);
    vi.mocked(useStartCopilotGithubApp).mockReturnValue(start as never);
    vi.spyOn(window, "open").mockReturnValue(null);
    const user = await continueWithOrganization("https://github.com/my-org");
    await user.click(
      screen.getByRole("button", { name: /Create a new GitHub App/ }),
    );

    expect(screen.getByText("Create the App on GitHub")).toBeInTheDocument();
    expect(screen.getByText("Install it on my-org")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create App" }));
    expect(start.mutate).toHaveBeenCalledWith(
      { organization: "https://github.com/my-org" },
      expect.anything(),
    );
  });

  it("connects an App by its ID and private key without rendering the key", async () => {
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation(undefined, {
        data: {
          fingerprint: "SHA256:abc=",
          installationId: "5",
          organization: "my-org",
        },
      }) as never,
    );
    const byKey = mutation(installed);
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      byKey as never,
    );
    const user = await continueWithOrganization();
    await user.click(
      screen.getByRole("button", {
        name: "Connect an App by its ID and private key",
      }),
    );
    await user.type(screen.getByLabelText("App ID"), "42");
    await user.upload(
      screen.getByLabelText("Private key"),
      new File(["-----BEGIN RSA PRIVATE KEY-----secret"], "app.pem"),
    );
    expect(screen.queryByText(/BEGIN RSA PRIVATE KEY/)).not.toBeInTheDocument();
    expect(screen.getByText("SHA256:abc=")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(byKey.mutate).toHaveBeenCalledWith(
      {
        appId: "42",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----secret",
        organization: "my-org",
      },
      expect.anything(),
    );
    expect(screen.getByText("Connected. 2 models:")).toBeInTheDocument();
  });

  it("reconnects at the App step with the key's own organization", async () => {
    const user = userEvent.setup();
    const fromCredential = mutation(installed);
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      fromCredential as never,
    );
    render(
      <CopilotOrganizationConnectDialog
        open
        onOpenChange={vi.fn()}
        replace={{ id: "key-1", organization: "other-org" }}
      />,
    );

    expect(screen.getByText("Reconnect GitHub Copilot")).toBeInTheDocument();
    expect(screen.queryByLabelText("GitHub organization")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    expect(fromCredential.mutate).toHaveBeenCalledWith(
      { credentialId: "cred-1", replaceKeyId: "key-1" },
      expect.anything(),
    );
  });
});

describe("hasClaudeOrGemini", () => {
  it("recognizes Claude or Gemini model ids", () => {
    expect(hasClaudeOrGemini(["gpt-4o", "claude-sonnet-4"])).toBe(true);
    expect(hasClaudeOrGemini(["gemini-2.5-pro"])).toBe(true);
    expect(hasClaudeOrGemini(["gpt-4o"])).toBe(false);
  });
});
