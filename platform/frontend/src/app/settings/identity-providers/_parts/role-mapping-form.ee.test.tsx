import { zodResolver } from "@hookform/resolvers/zod";
import {
  E2eTestId,
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
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

function TestWrapper({
  defaultRules = [],
  onSubmit,
}: {
  defaultRules?: Array<{ expression: string; role: string }>;
  onSubmit?: (data: IdentityProviderFormValues) => void;
}) {
  const form = useForm<IdentityProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: test setup
    resolver: zodResolver(IdentityProviderFormSchema as any),
    defaultValues: {
      providerId: "test",
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
      },
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((data) => onSubmit?.(data))}>
        <RoleMappingForm form={form} />
        <Button type="submit">Save</Button>
      </form>
    </Form>
  );
}

function getAddRuleButton() {
  return screen.getByTestId(E2eTestId.IdpRoleMappingAddRule);
}

function getDeleteButtons() {
  return screen
    .getAllByRole("button", { name: "" })
    .filter((btn) => btn.querySelector("svg.lucide-trash-2") !== null);
}

function openAccordion() {
  const trigger = screen.getByText("Role Mapping (Optional)");
  return userEvent.click(trigger);
}

describe("RoleMappingForm", () => {
  it("adds a rule when clicking Add Rule", async () => {
    render(<TestWrapper />);
    await openAccordion();

    expect(
      screen.getByText(
        "No mapping rules configured. All users will be assigned the default role.",
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
    await openAccordion();

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
    await openAccordion();

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
    await openAccordion();

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
    await openAccordion();

    expect(
      screen.getAllByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).toHaveLength(1);

    await userEvent.click(getDeleteButtons()[0]);

    expect(
      screen.queryByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No mapping rules configured. All users will be assigned the default role.",
      ),
    ).toBeInTheDocument();
  });

  it("adds a rule after removing one", async () => {
    render(
      <TestWrapper
        defaultRules={[{ expression: "existing", role: "admin" }]}
      />,
    );
    await openAccordion();

    await userEvent.click(getDeleteButtons()[0]);
    await userEvent.click(getAddRuleButton());

    const templates = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(templates).toHaveLength(1);
    expect(templates[0]).toHaveValue("");
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
    await openAccordion();

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
    await openAccordion();

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
