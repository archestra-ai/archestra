import { zodResolver } from "@hookform/resolvers/zod";
import {
  E2eTestId,
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
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
}: {
  defaultRules?: Array<{ expression: string; role: string }>;
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
      <form>
        <RoleMappingForm form={form} />
      </form>
    </Form>
  );
}

function getAddRuleButton() {
  return screen.getByTestId(E2eTestId.IdpRoleMappingAddRule);
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

    // Verify 3 rules rendered
    expect(
      screen.getAllByTestId(E2eTestId.IdpRoleMappingRuleTemplate),
    ).toHaveLength(3);

    // Remove the first rule (click the first trash button)
    const trashButtons = screen.getAllByRole("button", { name: "" });
    // Filter to only the trash icon buttons (they contain the Trash2 SVG)
    const deleteButtons = trashButtons.filter(
      (btn) => btn.querySelector("svg.lucide-trash-2") !== null,
    );
    expect(deleteButtons).toHaveLength(3);

    await userEvent.click(deleteButtons[0]);

    // Should now have 2 rules
    const remainingTemplates = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(remainingTemplates).toHaveLength(2);

    // Remaining rules should have correct values (rule-two and rule-three)
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

    const deleteButtons = screen
      .getAllByRole("button", { name: "" })
      .filter((btn) => btn.querySelector("svg.lucide-trash-2") !== null);

    // Remove the middle rule
    await userEvent.click(deleteButtons[1]);

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

    const deleteButtons = screen
      .getAllByRole("button", { name: "" })
      .filter((btn) => btn.querySelector("svg.lucide-trash-2") !== null);
    await userEvent.click(deleteButtons[0]);

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

    // Remove the existing rule
    const deleteButtons = screen
      .getAllByRole("button", { name: "" })
      .filter((btn) => btn.querySelector("svg.lucide-trash-2") !== null);
    await userEvent.click(deleteButtons[0]);

    // Add a new rule
    await userEvent.click(getAddRuleButton());

    const templates = screen.getAllByTestId(
      E2eTestId.IdpRoleMappingRuleTemplate,
    );
    expect(templates).toHaveLength(1);
    // New rule should have empty expression
    expect(templates[0]).toHaveValue("");
  });
});
