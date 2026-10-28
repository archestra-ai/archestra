import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import {
  useCheckCopilotGithubOrganization,
  useConnectCopilotGithubAppCredential,
  useConnectExistingCopilotGithubApp,
  useCopilotGithubAppKeySummary,
  useDiscardCopilotGithubApp,
  useInstallCopilotGithubApp,
  usePendingCopilotGithubApp,
  useStartCopilotGithubApp,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useLlmProviderApiKey,
  useUpdateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { CopilotOrganizationConnectDialog } from "./copilot-organization-connect-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/github-copilot-app.query", () => ({
  useCheckCopilotGithubOrganization: vi.fn(),
  useConnectCopilotGithubAppCredential: vi.fn(),
  useConnectExistingCopilotGithubApp: vi.fn(),
  useCopilotGithubAppKeySummary: vi.fn(),
  useDiscardCopilotGithubApp: vi.fn(),
  useInstallCopilotGithubApp: vi.fn(),
  usePendingCopilotGithubApp: vi.fn(),
  useStartCopilotGithubApp: vi.fn(),
  useValidateExistingCopilotGithubApp: vi.fn(),
}));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKey: vi.fn(),
  useUpdateLlmProviderApiKey: vi.fn(),
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

/** The App a key uses, as the key summary describes it. */
const keyApp = {
  organization: "my-org",
  appId: "42",
  appName: "My Org Copilot",
  appIcon: null,
  appUrl: "https://github.com/apps/my-org-copilot",
  githubUrl: "https://github.com",
  fingerprint: "SHA256:current=",
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
  vi.mocked(useCopilotGithubAppKeySummary).mockImplementation(
    (keyId) => ({ data: keyId ? keyApp : undefined }) as never,
  );
  vi.mocked(useLlmProviderApiKey).mockImplementation(
    (id) =>
      ({
        data: id ? { id, name: "GitHub Copilot (my-org)" } : undefined,
      }) as never,
  );
  vi.mocked(useUpdateLlmProviderApiKey).mockReturnValue(mutation({}) as never);
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
  await user.type(screen.getByLabelText("Organization"), value);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

describe("CopilotOrganizationConnectDialog", () => {
  it("asks for the GitHub and the organization, in the setup stepper", async () => {
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    const stepper = within(
      screen.getByRole("list", { name: "Setup progress" }),
    );
    for (const label of ["Organization", "GitHub App", "Access"])
      expect(stepper.getByText(label)).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub URL")).toHaveValue(
      "https://github.com",
    );
    const field = screen.getByLabelText("Organization");
    expect(field).toHaveAttribute("placeholder", "acme");
    expect(field).toHaveAccessibleDescription(
      "The GitHub organization with the Copilot plan.",
    );
    // The step holds only the field; what the App may do comes with the App.
    expect(screen.queryByText("What this allows")).toBeNull();
    expect(screen.queryByText(/Copilot requests/)).toBeNull();
  });

  it("shows the backend's organization error, shortened, in place of the help line", async () => {
    vi.mocked(useCheckCopilotGithubOrganization).mockReturnValue({
      ...mutation(),
      mutate: vi.fn(),
      error: new Error(
        "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
      ),
    } as never);
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    // One short line in the help line's place; GitHub's words in its tooltip.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "That's a personal account. Use an organization.",
    );
    expect(alert).toHaveAttribute(
      "title",
      "That's a personal account. Use an organization.",
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
      {
        credentialId: "cred-1",
        organization: "my-org",
        name: "GitHub Copilot (my-org)",
      },
      expect.anything(),
    );
    expect(
      screen.getByText("My Org Copilot can't make Copilot requests yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add Copilot Requests (Read-only) in its settings. An owner of my-org must approve the change.",
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
    // What the App may do is said once, with the ways to get it.
    expect(screen.queryByText(/can only make Copilot requests/)).toBeNull();
    expect(screen.getByText("Install it on my-org")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create App" }));
    expect(start.mutate).toHaveBeenCalledWith(
      { organization: "my-org" },
      expect.anything(),
    );
  });

  it("checks an organization on GitHub Enterprise Server by its address", async () => {
    const check = mutation({ organization: "acme" });
    vi.mocked(useCheckCopilotGithubOrganization).mockReturnValue(
      check as never,
    );
    const user = userEvent.setup();
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);
    await user.clear(screen.getByLabelText("GitHub URL"));
    await user.type(
      screen.getByLabelText("GitHub URL"),
      "https://git.example.com",
    );
    await user.type(screen.getByLabelText("Organization"), "acme");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(check.mutate).toHaveBeenCalledWith(
      { organization: "https://git.example.com/acme" },
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
    expect(screen.queryByText(/can only make Copilot requests/)).toBeNull();
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
      {
        appId: "42",
        privateKey: pem,
        organization: "my-org",
        name: "GitHub Copilot (my-org)",
      },
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
    expect(screen.getByLabelText("Organization")).toHaveValue("my-org");
    expect(screen.getByLabelText("Organization")).toBeEnabled();
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
    expect(screen.getByLabelText("Organization")).toBeDisabled();
    expect(screen.getByLabelText("Organization")).toHaveValue("my-org");
    expect(screen.getByLabelText("GitHub URL")).toBeDisabled();
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
        manage={{
          id: "key-1",
          name: "GitHub Copilot (other-org)",
          organization: "other-org",
          reconnect: true,
        }}
      />,
    );

    expect(screen.getByText("Reconnect GitHub Copilot")).toBeInTheDocument();
    expect(screen.queryByLabelText("Organization")).toBeNull();

    // Back shows the plan's organization, fixed; Continue needs no check.
    await user.click(screen.getByRole("button", { name: "Back" }));
    const field = screen.getByLabelText("Organization");
    expect(field).toBeDisabled();
    expect(field).toHaveValue("other-org");
    expect(screen.getByLabelText("GitHub URL")).toBeDisabled();
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
  it("shows the just-connected App on the App step after going back from Access", async () => {
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      mutation(installed) as never,
    );
    const user = await continueWithOrganization();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(
      screen.getByRole("link", { name: "My Org Copilot" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
  });

  it("takes an optional name, the default named after the organization", async () => {
    const fromCredential = mutation(installed);
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      fromCredential as never,
    );
    const user = userEvent.setup();
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);
    const name = screen.getByLabelText(/Name/);
    await user.type(screen.getByLabelText("Organization"), "my-org");
    expect(name).toHaveValue("");
    expect(name).toHaveAttribute("placeholder", "GitHub Copilot (my-org)");

    // Left empty, the plan gets the default.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    expect(fromCredential.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "GitHub Copilot (my-org)" }),
      expect.anything(),
    );
  });

  it("creates the plan with a name that was typed", async () => {
    const fromCredential = mutation(installed);
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      fromCredential as never,
    );
    const user = userEvent.setup();
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Organization"), "my-org");
    await user.type(screen.getByLabelText(/Name/), "Copilot");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    expect(fromCredential.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Copilot" }),
      expect.anything(),
    );
  });

  it("says what the App may do in one line under the three ways to get it", async () => {
    const user = await continueWithOrganization();

    expect(
      screen.getByText(
        /The App can only make Copilot requests, billed to my-org/,
      ),
    ).toHaveTextContent(
      "The App can only make Copilot requests, billed to my-org. Set a spending cap in Costs & Limits.",
    );
    expect(
      screen.getByRole("link", { name: "Costs & Limits" }),
    ).toHaveAttribute("href", "/llm/costs");
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    expect(screen.queryByText(/can only make Copilot requests/)).toBeNull();
  });
});

describe("CopilotOrganizationConnectDialog managing a plan", () => {
  const plan = {
    id: "key-1",
    name: "GitHub Copilot (my-org)",
    organization: "my-org",
  };
  // The App the plan uses, and one other the organization connected.
  const inUse = { ...connectedApp, id: "cred-42", appId: "42" };
  const other = {
    ...connectedApp,
    id: "cred-7",
    name: "Other App",
    appId: "7",
  };

  function renderManage(onOpenChange = vi.fn()) {
    const user = userEvent.setup();
    vi.mocked(useRuntimeCredentials).mockReturnValue({
      data: [inUse, other],
      isPending: false,
    } as unknown as ReturnType<typeof useRuntimeCredentials>);
    render(
      <CopilotOrganizationConnectDialog
        open
        onOpenChange={onOpenChange}
        manage={plan}
      />,
    );
    return user;
  }

  async function toAppStep() {
    const user = renderManage();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    return user;
  }

  it("opens at the organization, fixed, in the wizard's steps", async () => {
    const user = renderManage();

    expect(screen.getByText("Manage GitHub Copilot")).toBeInTheDocument();
    expect(
      screen.getByText("Your enterprise GitHub Copilot plan. Can be shared."),
    ).toBeInTheDocument();
    const stepper = within(
      screen.getByRole("list", { name: "Setup progress" }),
    );
    for (const label of ["Organization", "GitHub App", "Access"])
      expect(stepper.getByText(label)).toBeInTheDocument();
    const field = screen.getByLabelText("Organization");
    expect(field).toBeDisabled();
    expect(field).toHaveValue("my-org");
    // The key's GitHub, from its App.
    expect(screen.getByLabelText("GitHub URL")).toHaveValue(
      "https://github.com",
    );
    expect(screen.getByLabelText("GitHub URL")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("button", { name: /Create a new GitHub App/ }),
    ).toBeInTheDocument();
  });

  it("shows the App in use with the three ways to replace it, or Continue to keep it", async () => {
    const user = await toAppStep();

    expect(
      screen.getByRole("link", { name: "My Org Copilot" }),
    ).toHaveAttribute("href", "https://github.com/apps/my-org-copilot");
    for (const tile of [
      /Use an App I already have/,
      /Create a new GitHub App/,
      /Connect an App by its ID and private key/,
    ])
      expect(screen.getByRole("button", { name: tile })).toBeInTheDocument();
    // The App in use is not counted among the others.
    expect(
      screen.getByText("1 other App connected to My App."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });

  it("switches to another App on the same key", async () => {
    const fromCredential = mutation(installed);
    vi.mocked(useConnectCopilotGithubAppCredential).mockReturnValue(
      fromCredential as never,
    );
    const user = await toAppStep();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );

    expect(screen.getByLabelText(/Other App/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/My Org Copilot/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Use this App" }));
    expect(fromCredential.mutate).toHaveBeenCalledWith(
      { credentialId: "cred-7", replaceKeyId: "key-1" },
      expect.anything(),
    );
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });

  it("installs a new App onto the same key", async () => {
    const install = mutation(installed);
    vi.mocked(useInstallCopilotGithubApp).mockReturnValue(install as never);
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
    const user = await toAppStep();
    await user.click(
      screen.getByRole("button", { name: /Create a new GitHub App/ }),
    );
    await user.click(screen.getByRole("button", { name: /Install on GitHub/ }));
    await user.click(screen.getByRole("button", { name: /Check again/ }));

    expect(install.mutate).toHaveBeenCalledWith(
      { replaceKeyId: "key-1" },
      expect.anything(),
    );
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });

  it("rotates the private key from the key tile, starting from the App in use", async () => {
    const validate = mutation(undefined);
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      validate as never,
    );
    const byKey = mutation(installed);
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      byKey as never,
    );
    const user = await toAppStep();
    await user.click(
      screen.getByRole("button", {
        name: /Connect an App by its ID and private key/,
      }),
    );

    expect(screen.getByLabelText("App ID")).toHaveValue("42");
    expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
      /Key fingerprint:\s?SHA256:current=/,
    );
    expect(
      screen.getByRole("button", { name: "Replace credentials" }),
    ).toBeDisabled();

    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue({
      ...validate,
      data: { ...checkedKey, fingerprint: "SHA256:new=" },
    } as never);
    await user.upload(
      screen.getByLabelText("Private key"),
      new File([pem], "app.pem"),
    );
    expect(validate.mutate).toHaveBeenCalledWith({
      appId: "42",
      privateKey: pem,
      replaceKeyId: "key-1",
    });
    expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
      /Key fingerprint:\s?SHA256:new=/,
    );
    await user.click(
      screen.getByRole("button", { name: "Replace credentials" }),
    );
    expect(byKey.mutate).toHaveBeenCalledWith(
      { appId: "42", privateKey: pem, replaceKeyId: "key-1" },
      expect.anything(),
    );
  });

  it("keeps the name on the Organization step, editable, and saves a change on Done", async () => {
    const update = mutation({});
    vi.mocked(useUpdateLlmProviderApiKey).mockReturnValue(update as never);
    const onOpenChange = vi.fn();
    const user = renderManage(onOpenChange);

    const name = screen.getByLabelText(/Name/);
    expect(name).toHaveValue("GitHub Copilot (my-org)");
    expect(name).toHaveAttribute("placeholder", "GitHub Copilot (my-org)");
    expect(name).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Access is only who can use it.
    expect(screen.queryByRole("button", { name: /Advanced/ })).toBeNull();
    expect(screen.queryByText(/GitHub can't limit/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(update.mutate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.clear(screen.getByLabelText(/Name/));
    await user.type(screen.getByLabelText(/Name/), "Copilot for my-org");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(update.mutate).toHaveBeenCalledWith(
      { id: "key-1", data: { name: "Copilot for my-org" } },
      expect.anything(),
    );
  });
});
