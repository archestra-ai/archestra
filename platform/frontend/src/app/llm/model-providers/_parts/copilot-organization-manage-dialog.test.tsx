import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  useCopilotGithubAppKeySummary,
  useReplaceCopilotGithubAppPrivateKey,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { useUpdateLlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { CopilotOrganizationManageDialog } from "./copilot-organization-manage-dialog";

vi.mock("@/lib/github-copilot-app.query", () => ({
  useCopilotGithubAppKeySummary: vi.fn(),
  useReplaceCopilotGithubAppPrivateKey: vi.fn(),
  useValidateExistingCopilotGithubApp: vi.fn(),
}));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useUpdateLlmProviderApiKey: vi.fn(),
}));
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => <div>Access picker</div>,
}));

const apiKey = {
  id: "key-1",
  name: "GitHub Copilot (my-org)",
  provider: "github-copilot",
  userId: null,
  isPrimary: false,
  labels: [],
  isGithubAppKey: true,
  githubOrganization: "my-org",
} as unknown as LlmProviderApiKeyResponse;

const pem = "-----BEGIN RSA PRIVATE KEY-----new";

function mutation(extra?: Record<string, unknown>) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => ({})),
    reset: vi.fn(),
    isPending: false,
    error: null,
    data: undefined,
    ...extra,
  };
}

let replaceKey: ReturnType<typeof mutation>;
let update: ReturnType<typeof mutation>;

beforeEach(() => {
  vi.mocked(useCopilotGithubAppKeySummary).mockReturnValue({
    data: {
      organization: "my-org",
      appId: "42",
      appName: "My Org Copilot",
      appIcon: null,
      appUrl: "https://github.com/apps/my-org-copilot",
      fingerprint: "SHA256:old=",
    },
    isPending: false,
  } as never);
  vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
    mutation() as never,
  );
  replaceKey = mutation();
  update = mutation();
  vi.mocked(useReplaceCopilotGithubAppPrivateKey).mockReturnValue(
    replaceKey as never,
  );
  vi.mocked(useUpdateLlmProviderApiKey).mockReturnValue(update as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <CopilotOrganizationManageDialog
      apiKey={apiKey}
      existingKeys={[apiKey]}
      onOpenChange={onOpenChange}
    />,
  );
  return onOpenChange;
}

describe("CopilotOrganizationManageDialog", () => {
  it("shows the plan in the wizard's order, with nothing to save yet", () => {
    renderDialog();

    expect(screen.getByText("Manage GitHub Copilot")).toBeInTheDocument();
    expect(screen.getByText("my-org")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "My Org Copilot" }),
    ).toHaveAttribute("href", "https://github.com/apps/my-org-copilot");
    expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
      /Key fingerprint:\s?SHA256:old=/,
    );
    expect(screen.getByText("Access picker")).toBeInTheDocument();
    expect(screen.queryByText(/models?\b/i)).toBeNull();
    // Name and the rest wait, folded, under Advanced.
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("checks a dropped key right away and stores it on Save", async () => {
    const user = userEvent.setup();
    const validate = mutation({
      data: {
        fingerprint: "SHA256:new=",
        installationId: "5",
        organization: "my-org",
      },
    });
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      validate as never,
    );
    const onOpenChange = renderDialog();

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
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(replaceKey.mutateAsync).toHaveBeenCalledWith({
      id: "key-1",
      privateKey: pem,
    });
    // Only the key changed: the key's details are not rewritten.
    expect(update.mutateAsync).not.toHaveBeenCalled();
  });

  it("keeps Save off while a dropped key fails its check", async () => {
    const user = userEvent.setup();
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation({ error: new Error("This key is not the App's.") }) as never,
    );
    renderDialog();

    await user.upload(
      screen.getByLabelText("Private key"),
      new File([pem], "app.pem"),
    );
    expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
      "This key is not the App's.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("renames the plan from Advanced", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();

    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Copilot for my-org");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(replaceKey.mutateAsync).not.toHaveBeenCalled();
    expect(update.mutateAsync).toHaveBeenCalledWith({
      id: "key-1",
      data: { name: "Copilot for my-org", isPrimary: false, labels: [] },
    });
  });
});
