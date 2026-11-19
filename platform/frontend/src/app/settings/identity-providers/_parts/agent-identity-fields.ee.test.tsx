// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { IdentityProviderFormValues } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, test, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { AgentIdentityFields } from "./agent-identity-fields.ee";

vi.mock("@/lib/hooks/use-app-name", () => ({ useAppName: () => "Archestra" }));
vi.mock("@/lib/docs/docs", () => ({ getFrontendDocsUrl: () => null }));
vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => ({
    trustDomain: "archestra.example.com",
    issuer: "https://archestra.example.com/api/agent-identity/spiffe",
    jwksUri: "https://archestra.example.com/api/agent-identity/spiffe/keys",
    bundleUri: "https://archestra.example.com/api/agent-identity/spiffe/bundle",
  }),
}));

describe("AgentIdentityFields", () => {
  test("asks for the agents' key while each agent is its own client", () => {
    render(<Fields exchangeType="rfc8693" source={undefined} />);

    expect(screen.getByLabelText("Agent Private Key")).toBeVisible();
    expect(screen.queryByText("Issuer")).toBeNull();
  });

  test("shows the SPIFFE issuer to trust, and no key, for SPIFFE IDs", () => {
    render(<Fields exchangeType="rfc8693" source="spiffe" />);

    expect(screen.queryByLabelText("Agent Private Key")).toBeNull();
    expect(
      screen.getByText(
        "https://archestra.example.com/api/agent-identity/spiffe",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "https://archestra.example.com/api/agent-identity/spiffe/bundle",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText(/JWT-SVID Audience/)).toBeVisible();
  });

  test("offers Okta no SPIFFE IDs, which it does not take", () => {
    render(<Fields exchangeType="okta_managed" source="spiffe" />);

    expect(screen.queryByText("Agent Identity")).toBeNull();
    expect(screen.getByLabelText("Agent Private Key")).toBeVisible();
  });
});

function Fields({
  exchangeType,
  source,
}: {
  exchangeType: "okta_managed" | "rfc8693";
  source: "spiffe" | undefined;
}) {
  const form = useForm<IdentityProviderFormValues>({
    defaultValues: {
      providerId: "keycloak",
      issuer: "https://keycloak.example.com/realms/acme",
      domain: "example.com",
      providerType: "oidc",
      oidcConfig: {
        issuer: "https://keycloak.example.com/realms/acme",
        pkce: true,
        clientId: "archestra",
        discoveryEndpoint:
          "https://keycloak.example.com/realms/acme/.well-known/openid-configuration",
        mapping: { id: "sub", email: "email", name: "name" },
        enterpriseManagedCredentials: { agentIdentity: { source } },
      },
    } as IdentityProviderFormValues,
  });
  return (
    <Form {...form}>
      <AgentIdentityFields
        form={form}
        isSecretStored={() => false}
        exchangeType={exchangeType}
      />
    </Form>
  );
}
