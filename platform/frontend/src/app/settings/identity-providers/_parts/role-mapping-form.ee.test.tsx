import {
  E2eTestId,
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@archestra/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { RoleMappingForm } from "./role-mapping-form.ee";

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock the role query to return static roles
vi.mock("@/lib/role.query", () => ({
  useRoles: () => ({
    data: [
      { id: "1", role: "admin", name: "admin" },
      { id: "2", role: "member", name: "member" },
      { id: "3", role: "power-user", name: "power-user" },
    ],
    isPending: false,
  }),
}));

vi.mock("@/lib/organization.query");
// RoleSelectContent resolves the viewer's permissions (to grey out roles the
// viewer can't grant — moot here since IdP mappings opt out, but hooks run
// unconditionally); the canonical mock keeps it out of real query-land.
vi.mock("@/lib/auth/auth.query");

import { useAppearanceSettings } from "@/lib/organization.query";

vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useIdentityProviderLatestIdTokenClaims: () => ({
    data: {
      claims: {
        email: "admin@example.com",
        roles: ["app-admin"],
      },
      updatedAt: "2026-05-07T00:00:00.000Z",
    },
    isLoading: false,
  }),
}));

function TestWrapper({
  defaultRules = [],
  defaultRole = "member",
  onSubmit,
  providerId = "test",
  identityProviderId,
  strictMode = false,
}: {
  defaultRules?: Array<{ expression: string; role: string }>;
  defaultRole?: "admin" | "member" | string;
  onSubmit?: (data: IdentityProviderFormValues) => void;
  providerId?: string;
  identityProviderId?: string;
  strictMode?: boolean;
}) {
  const form = useForm<IdentityProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: test setup
    resolver: zodResolver(IdentityProviderFormSchema as any),
    defaultValues: {
      providerId,
      issuer: "https://example.com",
      domain: "example.com",
      providerType: "oidc",
      oidcConfig: {
        issuer: "https://example.com",
        pkce: true,
        clientId: "test",
        clientSecret: "secret",
        discoveryEndpoint: "",
        scopes: ["openid"],
        mapping: { id: "sub", email: "email", name: "name" },
      },
      roleMapping: {
        rules: defaultRules,
        defaultRole,
        strictMode,
      },
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((data) => onSubmit?.(data))}>
        <RoleMappingForm form={form} identityProviderId={identityProviderId} />
        <Button type="submit">Save</Button>
      </form>
    </Form>
  );
}

function getAddRuleButton() {
  return screen.getByTestId(E2eTestId.IdpRoleMappingAddRule);
}

function getDeleteButtons() {
  return screen.getAllByRole("button", { name: "Remove role mapping" });
}

beforeEach(() => {
  // Viewer permissions resolve to "still loading" — the IdP mapping picker
  // opts out of grantability filtering, so no roles are greyed out either way.
  vi.mocked(useAllPermissions).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useAllPermissions>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: { appName: "Spark" },
  } as unknown as ReturnType<typeof useAppearanceSettings>);
});

describe("RoleMappingForm", () => {
  it("automatically previews the first matching rule and updates when rules change", async () => {
    const user = userEvent.setup();
    render(
      <TestWrapper
        identityProviderId="idp-1"
        defaultRules={[
          {
            expression: '{{#includes roles "not-present"}}true{{/includes}}',
            role: "member",
          },
          {
            expression: '{{#includes roles "app-admin"}}true{{/includes}}',
            role: "admin",
          },
        ]}
      />,
    );
    // The first preview lazily imports Handlebars, which can exceed the
    // default one-second DOM wait while the full suite loads its modules.
    expect(
      await screen.findByText("Rule 2 → Admin", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    const first = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    )[0];
    await user.clear(first);
    await user.type(first, "true");
    expect(await screen.findByText("Rule 1 → Member")).toBeInTheDocument();
    expect(screen.queryByText("Tested below")).not.toBeInTheDocument();
  });

  it("shows the default role assignment when no role mapping rules match and strict mode is off", async () => {
    render(
      <TestWrapper
        identityProviderId="idp-1"
        defaultRole="member"
        defaultRules={[
          {
            expression: '{{#includes roles "not-present"}}true{{/includes}}',
            role: "admin",
          },
        ]}
      />,
    );

    expect(
      await screen.findByText("Default roles → Member"),
    ).toBeInTheDocument();
  });

  it("shows strict mode denial when no role mapping rules match", async () => {
    render(
      <TestWrapper
        identityProviderId="idp-1"
        strictMode
        defaultRole="member"
        defaultRules={[
          {
            expression: '{{#includes roles "not-present"}}true{{/includes}}',
            role: "admin",
          },
        ]}
      />,
    );

    expect(
      await screen.findByText("No matching rule · Sign-in denied"),
    ).toBeInTheDocument();
  });

  it("reorders role mapping rules with the keyboard drag handle", async () => {
    render(
      <TestWrapper
        defaultRules={[
          { expression: "first", role: "admin" },
          { expression: "second", role: "member" },
        ]}
      />,
    );

    const dragHandle = screen.getByRole("button", {
      name: "Drag role mapping rule 2",
    });
    dragHandle.focus();
    fireEvent.keyDown(dragHandle, { code: "ArrowUp", key: "ArrowUp" });

    const templates = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(templates[0]).toHaveValue("second");
    expect(templates[1]).toHaveValue("first");
  });

  it("adds a rule when clicking Add Rule", async () => {
    render(<TestWrapper />);
    expect(
      screen.getByText(
        "No mapping rules configured. All users will be assigned the default roles.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(getAddRuleButton());

    expect(
      screen.getAllByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).toHaveLength(1);
  });

  it("renders pre-existing rules", async () => {
    render(
      <TestWrapper
        defaultRules={[
          {
            expression: '{{#includes groups "admin"}}true{{/includes}}',
            role: "admin",
          },
          {
            expression: '{{#equals role "dev"}}true{{/equals}}',
            role: "member",
          },
        ]}
      />,
    );
    const templateInputs = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(templateInputs).toHaveLength(2);
  });

  it("removes a rule without causing validation errors on remaining rules", async () => {
    render(
      <TestWrapper
        defaultRules={[
          { expression: "rule-one", role: "admin" },
          { expression: "rule-two", role: "member" },
          { expression: "rule-three", role: "power-user" },
        ]}
      />,
    );
    expect(
      screen.getAllByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).toHaveLength(3);

    await userEvent.click(getDeleteButtons()[0]);

    const remainingTemplates = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(remainingTemplates).toHaveLength(2);
    expect(remainingTemplates[0]).toHaveValue("rule-two");
    expect(remainingTemplates[1]).toHaveValue("rule-three");

    // No validation errors should be shown
    expect(
      screen.queryByText("Invalid input: expected string, received undefined"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Expected string, received undefined"),
    ).not.toBeInTheDocument();
  });

  it("removes the middle rule correctly", async () => {
    render(
      <TestWrapper
        defaultRules={[
          { expression: "first", role: "admin" },
          { expression: "second", role: "member" },
          { expression: "third", role: "power-user" },
        ]}
      />,
    );
    await userEvent.click(getDeleteButtons()[1]);

    const remaining = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toHaveValue("first");
    expect(remaining[1]).toHaveValue("third");
  });

  it("removes the last rule correctly", async () => {
    render(
      <TestWrapper
        defaultRules={[{ expression: "only-rule", role: "admin" }]}
      />,
    );
    expect(
      screen.getAllByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).toHaveLength(1);

    await userEvent.click(getDeleteButtons()[0]);

    expect(
      screen.queryByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No mapping rules configured. All users will be assigned the default roles.",
      ),
    ).toBeInTheDocument();
  });

  it("adds a rule after removing one", async () => {
    render(
      <TestWrapper
        defaultRules={[{ expression: "existing", role: "admin" }]}
      />,
    );
    await userEvent.click(getDeleteButtons()[0]);
    await userEvent.click(getAddRuleButton());

    const templates = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(templates).toHaveLength(1);
    expect(templates[0]).toHaveValue("");
  });

  it("keeps at least one role and submits multiple rule and fallback roles", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TestWrapper
        defaultRules={[{ expression: "true", role: "member" }]}
        onSubmit={onSubmit}
      />,
    );
    for (const testId of [
      E2eTestId.IdpRoleMappingRuleRole,
      E2eTestId.IdpRoleMappingDefaultRole,
    ]) {
      await user.click(screen.getByTestId(testId));
      expect(screen.getByRole("option", { name: /^Member/ })).toBeDisabled();
      await user.click(screen.getByRole("option", { name: /^Admin/ }));
      await user.keyboard("{Escape}");
    }
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          roleMapping: expect.objectContaining({
            rules: [{ expression: "true", role: "member,admin" }],
            defaultRole: "member,admin",
          }),
        }),
      ),
    );
  });

  it("submits form successfully with role mapping rules", async () => {
    const onSubmit = vi.fn();
    render(
      <TestWrapper
        defaultRules={[
          { expression: "rule-one", role: "admin" },
          { expression: "rule-two", role: "member" },
        ]}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submittedData = onSubmit.mock.calls[0][0];
    expect(submittedData.roleMapping.rules).toHaveLength(2);
    expect(submittedData.roleMapping.rules[0].expression).toBe("rule-one");
    expect(submittedData.roleMapping.rules[1].expression).toBe("rule-two");
  });

  it("submits form successfully after removing a rule", async () => {
    const onSubmit = vi.fn();
    render(
      <TestWrapper
        defaultRules={[
          { expression: "keep-this", role: "admin" },
          { expression: "remove-this", role: "member" },
        ]}
        onSubmit={onSubmit}
      />,
    );
    // Remove the second rule
    await userEvent.click(getDeleteButtons()[1]);

    // Submit should succeed without validation errors
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submittedData = onSubmit.mock.calls[0][0];
    expect(submittedData.roleMapping.rules).toHaveLength(1);
    expect(submittedData.roleMapping.rules[0].expression).toBe("keep-this");
  });

  it("submits form successfully with no role mapping rules", async () => {
    const onSubmit = vi.fn();
    render(<TestWrapper onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submittedData = onSubmit.mock.calls[0][0];
    expect(submittedData.roleMapping.rules).toHaveLength(0);
  });

  it("submits form successfully after removing all rules", async () => {
    const onSubmit = vi.fn();
    render(
      <TestWrapper
        defaultRules={[{ expression: "remove-me", role: "admin" }]}
        onSubmit={onSubmit}
      />,
    );
    // Remove the only rule
    await userEvent.click(getDeleteButtons()[0]);

    // Submit should succeed
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submittedData = onSubmit.mock.calls[0][0];
    expect(submittedData.roleMapping.rules).toHaveLength(0);
  });
});
