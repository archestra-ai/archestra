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

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function TestWrapper({
  onSubmit,
}: {
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
        disablePostLogoutRedirectUri: false,
        clientId: "test",
        clientSecret: "secret",
        discoveryEndpoint: "https://example.com/.well-known/openid-configuration",
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
  it("submits the logout redirect toggle when enabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<TestWrapper onSubmit={onSubmit} />);

    await user.click(screen.getByLabelText("Omit logout redirect URI"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        oidcConfig: expect.objectContaining({
          disablePostLogoutRedirectUri: true,
        }),
      }),
    );
  });
});
