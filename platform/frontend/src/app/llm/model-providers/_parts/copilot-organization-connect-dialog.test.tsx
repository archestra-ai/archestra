import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { CopilotOrganizationConnectDialog } from "./copilot-organization-connect-dialog";

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

const checkedKey = {
  fingerprint: "SHA256:abc=",
  installationId: "5",
  organization: "my-org",
};
const pem = "-----BEGIN RSA PRIVATE KEY-----secret";

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
      "acme or https://github.com/acme",
    );
    expect(field).toHaveAccessibleDescription(
      "Organization's GitHub handle or URL",
    );
    // The step holds only the field; what the App may do comes with the App.
    expect(screen.queryByText("What this allows")).toBeNull();
    expect(screen.queryByText(/Copilot requests/)).toBeNull();
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

  it("goes to Access once a picked App connects, with only who may use it", async () => {
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      mutation(installed) as never,
    );
    const user = await continueWithOrganization();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));

    expect(screen.getByText("Access picker")).toBeInTheDocument();
    expect(screen.queryByText(/models/)).toBeNull();
    expect(screen.queryByText(/Claude or Gemini/)).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
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
    expect(
      screen.getByText(
        "The App only needs Copilot requests, nothing else in the organization. Requests are paid from my-org's AI credits.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Copilot requests")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("Install it on my-org")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create App" }));
    expect(start.mutate).toHaveBeenCalledWith(
      { organization: "https://github.com/my-org" },
      expect.anything(),
    );
  });

  it("checks the key once both fields are filled and connects from the footer", async () => {
    const validate = mutation(undefined, { data: checkedKey });
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      validate as never,
    );
    const byKey = mutation(installed);
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      byKey as never,
    );
    const user = await continueWithOrganization();
    expect(
      screen.getByText("For an App that isn't connected to My App yet."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /Connect an App by its ID and private key/,
      }),
    );
    expect(
      screen.getByText(
        "The App only needs Copilot requests, nothing else in the organization. Requests are paid from my-org's AI credits.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check App/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

    await user.type(screen.getByLabelText("App ID"), "42");
    await user.upload(
      screen.getByLabelText("Private key"),
      new File([pem], "app.pem"),
    );
    // A dropped key is checked right away.
    expect(validate.mutate).toHaveBeenCalledWith({
      appId: "42",
      privateKey: pem,
      organization: "my-org",
    });
    expect(screen.queryByText(/BEGIN RSA PRIVATE KEY/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
      /Key fingerprint:\s?SHA256:abc=/,
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(byKey.mutate).toHaveBeenCalledWith(
      { appId: "42", privateKey: pem, organization: "my-org" },
      expect.anything(),
    );
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });

  it("waits for a passing check before Connect, and checks again after the App ID changes", async () => {
    const validate = mutation(undefined, {
      error: new Error("GitHub doesn't know App 43."),
    });
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      validate as never,
    );
    const user = await continueWithOrganization();
    await user.click(
      screen.getByRole("button", {
        name: /Connect an App by its ID and private key/,
      }),
    );
    await user.upload(
      screen.getByLabelText("Private key"),
      new File([pem], "app.pem"),
    );
    // Only the key so far: nothing to check yet.
    expect(validate.mutate).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("App ID"), "43");
    await waitFor(() =>
      expect(validate.mutate).toHaveBeenLastCalledWith({
        appId: "43",
        privateKey: pem,
        organization: "my-org",
      }),
    );
    // Typing pauses before a check: one check for "43", not one per digit.
    expect(validate.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "GitHub doesn't know App 43.",
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("goes back from every step, and back from Access works on the connected key", async () => {
    const fromCredential = mutation(installed);
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      fromCredential as never,
    );
    const user = await continueWithOrganization();

    // App step, choose: back to the organization, still editable.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("GitHub organization")).toHaveValue("my-org");
    expect(screen.getByLabelText("GitHub organization")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Each way to get an App goes back to the choice.
    for (const tile of [
      /Use an App I already have/,
      /Create a new GitHub App/,
      /Connect an App by its ID and private key/,
    ]) {
      await user.click(screen.getByRole("button", { name: tile }));
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(
        screen.getByRole("button", { name: /Create a new GitHub App/ }),
      ).toBeInTheDocument();
    }

    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    expect(screen.getByText("Access picker")).toBeInTheDocument();

    // Back from Access: the App step now replaces the connected key's App.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    expect(fromCredential.mutate).toHaveBeenLastCalledWith(
      { credentialId: "cred-1", replaceKeyId: "key-1" },
      expect.anything(),
    );

    // Its organization is fixed now.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("GitHub organization")).toBeDisabled();
    expect(screen.getByLabelText("GitHub organization")).toHaveValue("my-org");
  });

  it("installs a new App made from Access onto the connected key", async () => {
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      mutation(installed) as never,
    );
    vi.mocked(usePendingCopilotGithubApp).mockReturnValue({
      data: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePendingCopilotGithubApp>);
    const install = mutation({ status: "waiting" });
    vi.mocked(useInstallCopilotGithubApp).mockReturnValue(install as never);
    const user = await continueWithOrganization();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(
      screen.getByRole("button", { name: /Create a new GitHub App/ }),
    );
    // The install row's Check again asks the backend to finish the install.
    vi.mocked(usePendingCopilotGithubApp).mockReturnValue({
      data: {
        account: "my-org",
        accountUrl: "https://github.com/my-org",
        name: "My Org Copilot 2",
        htmlUrl: "https://github.com/apps/my-org-copilot-2",
        installUrl:
          "https://github.com/apps/my-org-copilot-2/installations/new",
      },
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePendingCopilotGithubApp>);
    vi.spyOn(window, "open").mockReturnValue(null);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(
      screen.getByRole("button", { name: /Create a new GitHub App/ }),
    );
    await user.click(screen.getByRole("button", { name: /Install on GitHub/ }));
    await user.click(screen.getByRole("button", { name: /Check again/ }));
    expect(install.mutate).toHaveBeenCalledWith(
      { replaceKeyId: "key-1" },
      expect.anything(),
    );
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

    // Back shows the plan's organization, fixed; Continue needs no check.
    await user.click(screen.getByRole("button", { name: "Back" }));
    const field = screen.getByLabelText("GitHub organization");
    expect(field).toBeDisabled();
    expect(field).toHaveValue("other-org");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      vi.mocked(useCheckCopilotGithubOrganization).mock.results[0]?.value
        .mutate,
    ).not.toHaveBeenCalled();

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
