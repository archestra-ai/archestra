import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import {
  type IdentityProviderDialogSection,
  IdentityProviderDialogShell,
} from "./identity-provider-dialog-shell.ee";

function TestDialog({ onSubmit }: { onSubmit: () => void }) {
  const [activeSection, setActiveSection] =
    useState<IdentityProviderDialogSection>("general");
  const form = useForm<IdentityProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: test setup
    resolver: zodResolver(IdentityProviderFormSchema as any),
    defaultValues: {
      providerId: "test-idp",
      issuer: "https://example.com",
      ssoLoginEnabled: true,
      domain: "",
      providerType: "oidc",
      oidcConfig: {
        issuer: "https://example.com",
        pkce: true,
        clientId: "client",
        clientSecret: "secret",
        discoveryEndpoint:
          "https://example.com/.well-known/openid-configuration",
        scopes: ["openid"],
        mapping: { id: "sub", email: "email", name: "name" },
      },
      roleMapping: { rules: [] },
    },
  });

  return (
    <IdentityProviderDialogShell
      open
      onOpenChange={vi.fn()}
      title="Edit Identity Provider"
      description="Update provider settings."
      providerLabel="test-idp"
      form={form}
      activeSection={activeSection}
      navItems={[
        { id: "general", label: "OIDC Settings" },
        { id: "role-mapping", label: "Role Mapping" },
        { id: "team-sync", label: "Team Sync" },
      ]}
      onActiveSectionChange={setActiveSection}
      onSubmit={form.handleSubmit(onSubmit)}
      footer={<Button type="submit">Save</Button>}
    >
      <div>{activeSection}</div>
    </IdentityProviderDialogShell>
  );
}

describe("IdentityProviderDialogShell", () => {
  it("switches sidebar sections and submits from the active section", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<TestDialog onSubmit={onSubmit} />);

    expect(screen.getByText("general")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Team Sync" }));
    expect(screen.getByText("team-sync")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
