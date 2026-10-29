import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@archestra/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { useAppearanceSettings } from "@/lib/organization.query";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

vi.mock("@/lib/organization.query");

vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useIdentityProviderLatestIdTokenClaims: () => ({
    data: {
      claims: {
        groups: ["engineering"],
      },
      updatedAt: "2026-05-07T00:00:00.000Z",
    },
    isLoading: false,
  }),
}));

function TestWrapper({
  providerId,
  identityProviderId,
}: {
  providerId: string;
  identityProviderId?: string;
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
        rules: [],
      },
      teamSyncConfig: {
        enabled: true,
        groupsExpression: "",
      },
    },
  });

  return (
    <Form {...form}>
      <TeamSyncConfigForm form={form} identityProviderId={identityProviderId} />
    </Form>
  );
}

beforeEach(() => {
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: { appName: "Spark" },
  } as unknown as ReturnType<typeof useAppearanceSettings>);
});

describe("TeamSyncConfigForm", () => {
  it("extracts groups automatically and updates as the template changes", async () => {
    const user = userEvent.setup();
    render(<TestWrapper providerId="Okta" identityProviderId="idp-1" />);
    expect(await screen.findByText("1 groups extracted")).toBeInTheDocument();
    const template = screen.getByLabelText("Groups Handlebars Template");
    await user.type(template, "custom-group");
    expect(
      await screen.findByText("custom-group", { selector: "span" }),
    ).toBeInTheDocument();
    await user.clear(template);
    expect(
      await screen.findByText("Default extraction from the sign-in data."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Enable Team Sync" }),
    );
    expect(await screen.findByText("Team Sync is off")).toBeInTheDocument();
    expect(screen.queryByText("1 groups extracted")).not.toBeInTheDocument();
  });
});
