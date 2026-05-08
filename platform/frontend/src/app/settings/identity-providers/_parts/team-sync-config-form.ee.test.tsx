import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

vi.mock("@/lib/organization.query", () => ({
  useAppearanceSettings: () => ({
    data: {
      appName: "Spark",
    },
  }),
}));

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

describe("TeamSyncConfigForm", () => {
  it("shows latest ID token claims when editing an existing provider", async () => {
    render(<TestWrapper providerId="Okta" identityProviderId="idp-1" />);
    expect(screen.getAllByText(/engineering/i).length).toBeGreaterThan(0);
  });

  it("shows a live template test result for team sync extraction", async () => {
    const user = userEvent.setup();

    render(<TestWrapper providerId="Okta" identityProviderId="idp-1" />);
    await user.type(
      screen.getByLabelText("Groups Handlebars Template"),
      "{{#each groups}}{{this}},{{/each}}",
    );

    expect(screen.getByText("Live Template Test")).toBeInTheDocument();
    expect(await screen.findByText("Groups extracted")).toBeInTheDocument();
    expect(
      screen.getByText(/group identifier.*extracted/i),
    ).toBeInTheDocument();
  });

  it("tests default team sync extraction when the template is empty", async () => {
    render(<TestWrapper providerId="Okta" identityProviderId="idp-1" />);
    expect(screen.getByText("Live Template Test")).toBeInTheDocument();
    expect(await screen.findByText("Groups extracted")).toBeInTheDocument();
    expect(screen.getByText(/using default extraction/i)).toBeInTheDocument();
    expect(screen.queryByText("Enter a template to test.")).toBeNull();
  });

  it("shows the Okta groups claim hint", async () => {
    render(<TestWrapper providerId="Okta" />);
    expect(
      screen.getByText(/Okta team sync commonly reads group names/i),
    ).toBeInTheDocument();
  });

  it("shows the Entra groups and roles claim hint", async () => {
    render(<TestWrapper providerId="EntraID" />);
    expect(
      screen.getByText(/Microsoft Entra ID team sync commonly reads/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/sync teams from Entra App roles/i),
    ).toBeInTheDocument();
  });
});
