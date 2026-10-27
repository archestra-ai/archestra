import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import { useLlmModels } from "@/lib/llm-models.query";
import { useResourcePermissions } from "@/lib/resource-permissions.query";
import {
  describeKeyAudience,
  OrganizationSubscriptionCards,
} from "./organization-subscription-cards";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/llm-models.query", () => ({ useLlmModels: vi.fn() }));
vi.mock("@/lib/resource-permissions.query", () => ({
  useResourcePermissions: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: hasPermissions(
          { llmProviderApiKey: ["read", "create", "update"] },
          permissions,
        ),
      }) as ReturnType<typeof useHasPermissions>,
  );
  vi.mocked(useLlmModels).mockReturnValue({
    data: [{ id: "gpt-4o" }, { id: "gpt-4.1" }],
  } as unknown as ReturnType<typeof useLlmModels>);
  vi.mocked(useResourcePermissions).mockReturnValue({
    data: {
      grants: [
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
          name: "Everyone",
        },
      ],
    },
  } as unknown as ReturnType<typeof useResourcePermissions>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const handlers = () => ({
  onConnect: vi.fn(),
  onManageAccess: vi.fn(),
  onReplace: vi.fn(),
  onDisconnect: vi.fn(),
});

describe("OrganizationSubscriptionCards", () => {
  it("offers to connect when no organization is connected", async () => {
    const user = userEvent.setup();
    const props = handlers();
    render(
      <OrganizationSubscriptionCards
        credentials={[]}
        isLoading={false}
        {...props}
      />,
    );

    expect(
      screen.getByText("Use your GitHub organization's Copilot plan"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(props.onConnect).toHaveBeenCalledOnce();
  });

  it("shows who pays, how many models and who can use a connected organization", async () => {
    const user = userEvent.setup();
    const props = handlers();
    const credential = {
      id: "key-1",
      provider: "github-copilot",
      name: "GitHub Copilot (acme)",
      scope: "org",
      isGithubAppKey: true,
      githubOrganization: "acme",
    } as LlmProviderApiKeyResponse;
    render(
      <OrganizationSubscriptionCards
        credentials={[credential]}
        isLoading={false}
        {...props}
      />,
    );

    expect(
      screen.getByText("acme · billed to acme on GitHub"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 models · Everyone in the organization"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage access" }));
    expect(props.onManageAccess).toHaveBeenCalledWith(credential);
  });
});

describe("describeKeyAudience", () => {
  it("names the people granted use, or says admins only", () => {
    expect(
      describeKeyAudience([
        {
          subject: { type: "team" },
          actions: ["read", "use"],
          name: "Platform",
        },
        { subject: { type: "user" }, actions: ["read"], name: "Read only" },
      ]),
    ).toBe("Platform");
    expect(describeKeyAudience([])).toBe("Admins only");
  });
});
