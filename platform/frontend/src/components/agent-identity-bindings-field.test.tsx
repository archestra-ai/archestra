// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  AgentIdentityBindingsField,
  agentIdentityBindingsToSave,
  agentIdentityProviders,
} from "./agent-identity-bindings-field";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/docs/docs", () => ({ getFrontendDocsUrl: () => null }));

type IdentityProvider =
  archestraApiTypes.GetIdentityProvidersResponses["200"][number];

const ENTRA = makeProvider("entra", {
  entraAgentId: { blueprintClientId: "blueprint" },
});
const OKTA = makeProvider("okta", { agentIdentity: {} }, [
  "oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem",
]);
const OKTA_WITHOUT_KEY = makeProvider("okta-without-key", {
  agentIdentity: { requireAgentIdentity: true },
});
const PLAIN = makeProvider("plain", {});

describe("agentIdentityProviders", () => {
  test("offers providers with a blueprint or a stored agent key, and any still bound so it can be cleared", () => {
    expect(
      agentIdentityProviders({
        identityProviders: [ENTRA, OKTA, OKTA_WITHOUT_KEY, PLAIN],
        bindings: {},
      }).map((provider) => provider.id),
    ).toEqual(["entra", "okta"]);
    expect(
      agentIdentityProviders({
        identityProviders: [PLAIN],
        bindings: { plain: "wlp-agent" },
      }).map((provider) => provider.id),
    ).toEqual(["plain"]);
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

  test("edits the identity at one provider without touching the others", () => {
    const onChange = vi.fn();
    render(
      <AgentIdentityBindingsField
        identityProviders={[ENTRA, OKTA]}
        value={{ entra: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0" }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^okta:/), {
      target: { value: "wlp-agent" },
    });

    expect(onChange).toHaveBeenCalledWith({
      entra: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
      okta: "wlp-agent",
    });
  });

  test("is read-only without permission to update identity providers", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    render(
      <AgentIdentityBindingsField
        identityProviders={[OKTA]}
        value={{}}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/^okta:/)).toBeDisabled();
    expect(
      screen.getByText(/requires permission to update identity providers/),
    ).toBeInTheDocument();
  });
});

function makeProvider(
  id: string,
  enterpriseManagedCredentials: Record<string, unknown>,
  configuredSecretPaths: string[] = [],
): IdentityProvider {
  return {
    id,
    providerId: id,
    oidcConfig: { enterpriseManagedCredentials },
    configuredSecretPaths,
  } as unknown as IdentityProvider;
}
