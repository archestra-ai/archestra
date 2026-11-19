// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  AgentIdentityBindingsField,
  agentIdentityBindingsToSave,
  shownAgentIdentityProviders,
} from "./agent-identity-bindings-field";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => ({ trustDomain: "archestra.example.com" }),
}));
vi.mock("@/lib/docs/docs", () => ({ getFrontendDocsUrl: () => null }));

type IdentityProvider =
  archestraApiTypes.GetIdentityProvidersResponses["200"][number];

const AGENT_KEY_PATH =
  "oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem";
const ENTRA = makeProvider({
  id: "entra",
  issuer: "https://login.microsoftonline.com/tenant/v2.0",
  enterpriseManagedCredentials: {
    entraAgentId: { blueprintClientId: "blueprint" },
  },
});
const OKTA = makeProvider({
  id: "okta",
  issuer: "https://example.okta.com",
  enterpriseManagedCredentials: { agentIdentity: {} },
  configuredSecretPaths: [AGENT_KEY_PATH],
});
const KEYCLOAK = makeProvider({
  id: "keycloak",
  issuer: "https://keycloak.example.com/realms/archestra",
  enterpriseManagedCredentials: { agentIdentity: {} },
  configuredSecretPaths: [AGENT_KEY_PATH],
});
const KEYCLOAK_SPIFFE = makeProvider({
  id: "keycloak-spiffe",
  issuer: "https://keycloak.example.com/realms/spiffe",
  enterpriseManagedCredentials: {
    exchangeStrategy: "rfc8693",
    agentIdentity: { source: "spiffe" },
  },
});
const KEYCLOAK_WITHOUT_KEY = makeProvider({
  id: "keycloak-without-key",
  issuer: "https://keycloak.example.com/realms/other",
  enterpriseManagedCredentials: {
    agentIdentity: { requireAgentIdentity: true },
  },
});

describe("shownAgentIdentityProviders", () => {
  test("shows the agent's own provider when it takes agent identities, and every provider the agent is bound at", () => {
    const shown = (params: {
      selectedIdentityProviderId: string | null;
      bindings: Record<string, string>;
    }) =>
      shownAgentIdentityProviders({
        identityProviders: [ENTRA, OKTA, KEYCLOAK, KEYCLOAK_WITHOUT_KEY],
        ...params,
      }).map((provider) => provider.id);

    expect(shown({ selectedIdentityProviderId: "okta", bindings: {} })).toEqual(
      ["okta"],
    );
    expect(
      shown({
        selectedIdentityProviderId: "keycloak-without-key",
        bindings: {},
      }),
    ).toEqual([]);
    expect(
      shown({ selectedIdentityProviderId: null, bindings: { entra: "id" } }),
    ).toEqual(["entra"]);
  });
});

describe("agentIdentityBindingsToSave", () => {
  test("drops cleared fields and trims the rest", () => {
    expect(
      agentIdentityBindingsToSave({ okta: "  wlp-agent ", entra: "  " }),
    ).toEqual([{ identityProviderId: "okta", externalId: "wlp-agent" }]);
  });
});

describe("AgentIdentityBindingsField", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
  });

  test("names each identity the way its provider does", () => {
    render(
      <AgentIdentityBindingsField
        agentId="agent-1"
        identityProviders={[ENTRA, OKTA, KEYCLOAK]}
        selectedIdentityProviderId={null}
        value={{ entra: "", okta: "", keycloak: "" }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/Entra agent identity app ID/)).toBeVisible();
    expect(screen.getByLabelText(/Okta AI agent client ID/)).toBeVisible();
    expect(screen.getByLabelText(/^Agent client ID/)).toBeVisible();
  });

  test("edits one identity without touching the others", () => {
    const onChange = vi.fn();
    render(
      <AgentIdentityBindingsField
        agentId="agent-1"
        identityProviders={[ENTRA, OKTA]}
        selectedIdentityProviderId="okta"
        value={{ entra: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0" }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Okta AI agent client ID/), {
      target: { value: "wlp-agent" },
    });

    expect(onChange).toHaveBeenCalledWith({
      entra: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
      okta: "wlp-agent",
    });
  });

  test("removes an identity at a provider other than the agent's own", () => {
    const onChange = vi.fn();
    render(
      <AgentIdentityBindingsField
        agentId="agent-1"
        identityProviders={[ENTRA, OKTA]}
        selectedIdentityProviderId="okta"
        value={{ entra: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", okta: "x" }}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove the identity at entra" }),
    );

    expect(onChange).toHaveBeenCalledWith({ okta: "x" });
    expect(
      screen.queryByRole("button", { name: "Remove the identity at okta" }),
    ).toBeNull();
  });

  test("shows the agent's SPIFFE ID at a provider that takes them, with nothing to enter or add", () => {
    render(
      <AgentIdentityBindingsField
        agentId="agent-1"
        identityProviders={[KEYCLOAK_SPIFFE]}
        selectedIdentityProviderId="keycloak-spiffe"
        value={{}}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("spiffe://archestra.example.com/agent/agent-1"),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.queryByText("Add an identity at another provider"),
    ).toBeNull();
  });

  test("is read-only without permission to update identity providers", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    render(
      <AgentIdentityBindingsField
        agentId="agent-1"
        identityProviders={[OKTA, KEYCLOAK]}
        selectedIdentityProviderId="okta"
        value={{}}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/Okta AI agent client ID/)).toBeDisabled();
    expect(
      screen.queryByText("Add an identity at another provider"),
    ).toBeNull();
    expect(
      screen.getByText(/requires permission to update identity providers/),
    ).toBeInTheDocument();
  });
});

function makeProvider(params: {
  id: string;
  issuer: string;
  enterpriseManagedCredentials: Record<string, unknown>;
  configuredSecretPaths?: string[];
}): IdentityProvider {
  return {
    id: params.id,
    providerId: params.id,
    issuer: params.issuer,
    oidcConfig: {
      enterpriseManagedCredentials: params.enterpriseManagedCredentials,
    },
    configuredSecretPaths: params.configuredSecretPaths ?? [],
  } as unknown as IdentityProvider;
}
