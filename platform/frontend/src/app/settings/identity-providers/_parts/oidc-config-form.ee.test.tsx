import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { OidcConfigForm } from "./oidc-config-form.ee";

vi.mock("./role-mapping-form.ee", () => ({
  RoleMappingForm: () => <div>Role Mapping</div>,
}));

vi.mock("./team-sync-config-form.ee", () => ({
  TeamSyncConfigForm: () => <div>Team Sync</div>,
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function TestWrapper({
  onSubmit,
  providerId = "test",
}: {
  onSubmit?: (data: IdentityProviderFormValues) => void;
  providerId?: string;
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
        enableRpInitiatedLogout: true,
        hd: "",
        clientId: "test",
        clientSecret: "secret",
        discoveryEndpoint:
          "https://example.com/.well-known/openid-configuration",
        scopes: ["openid"],
        mapping: { id: "sub", email: "email", name: "name" },
      },
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((data) => onSubmit?.(data))}>
        <OidcConfigForm form={form} />
        <Button type="submit">Save</Button>
      </form>
    </Form>
  );
}

describe("OidcConfigForm", () => {
  it("defaults RP-Initiated Logout to enabled", async () => {
    render(<TestWrapper />);

    expect(screen.getByLabelText("Enable RP-Initiated Logout")).toBeChecked();
  });

  it("submits the RP-Initiated Logout toggle when disabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<TestWrapper onSubmit={onSubmit} />);

    await user.click(screen.getByLabelText("Enable RP-Initiated Logout"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        oidcConfig: expect.objectContaining({
          enableRpInitiatedLogout: false,
        }),
      }),
    );
  });

  it("explains that allowed email domains gate SSO sign-in", () => {
    render(<TestWrapper />);

    expect(screen.getByLabelText("Allowed Email Domains")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Users can sign in with this provider only when their returned email matches one of these domains/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows the hosted domain field for Google providers", () => {
    render(<TestWrapper providerId="Google" />);

    expect(
      screen.getByLabelText("Hosted Domain Hint (Optional)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This is a Google hint, not the security boundary/i),
    ).toBeInTheDocument();
  });

  it("hides the hosted domain field for non-Google providers", () => {
    render(<TestWrapper />);

    expect(
      screen.queryByLabelText("Hosted Domain Hint (Optional)"),
    ).not.toBeInTheDocument();
  });
});
