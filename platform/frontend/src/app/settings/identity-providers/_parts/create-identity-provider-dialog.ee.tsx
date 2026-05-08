"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  E2eTestId,
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { useCallback, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useCreateIdentityProvider } from "@/lib/auth/identity-provider.query.ee";
import { getIdentityProviderDialogNavItems } from "./identity-provider-dialog-nav-items.ee";
import {
  type IdentityProviderDialogSection,
  IdentityProviderDialogShell,
} from "./identity-provider-dialog-shell.ee";
import { normalizeIdentityProviderFormValues } from "./identity-provider-form.utils";
import { OidcConfigForm } from "./oidc-config-form.ee";
import { SamlConfigForm } from "./saml-config-form.ee";

interface CreateIdentityProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultValues?: Partial<IdentityProviderFormValues>;
  providerName?: string;
  /** Hide the PKCE checkbox (for providers that don't support it like GitHub) */
  hidePkce?: boolean;
  /** Hide the Provider ID field (for predefined providers like Okta, Google, GitHub) */
  hideProviderId?: boolean;
  /** Provider type: oidc or saml */
  providerType?: "oidc" | "saml";
}

export function CreateIdentityProviderDialog({
  open,
  onOpenChange,
  defaultValues,
  providerName,
  hidePkce,
  hideProviderId,
  providerType = "oidc",
}: CreateIdentityProviderDialogProps) {
  const createIdentityProvider = useCreateIdentityProvider();
  const [activeSection, setActiveSection] =
    useState<IdentityProviderDialogSection>("general");

  const form = useForm<IdentityProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(IdentityProviderFormSchema as any),
    defaultValues: {
      roleMapping: { rules: [] },
      ...(defaultValues || {
        providerId: "",
        issuer: "",
        ssoLoginEnabled: true,
        domain: "",
        providerType: providerType,
        ...(providerType === "saml"
          ? {
              samlConfig: {
                issuer: "",
                entryPoint: "",
                cert: "",
                callbackUrl: "",
                spMetadata: {},
              },
            }
          : {
              oidcConfig: {
                issuer: "",
                pkce: true,
                enableRpInitiatedLogout: true,
                clientId: "",
                clientSecret: "",
                discoveryEndpoint: "",
                scopes: ["openid", "email", "profile"],
                mapping: {
                  id: "sub",
                  email: "email",
                  name: "name",
                },
                overrideUserInfo: true,
              },
            }),
      }),
    },
  });

  const onSubmit = useCallback(
    async (data: IdentityProviderFormValues) => {
      const result = await createIdentityProvider.mutateAsync(
        normalizeIdentityProviderFormValues(data),
      );
      // Only close the dialog if creation succeeded (result is not null)
      if (result) {
        form.reset();
        onOpenChange(false);
      }
    },
    [createIdentityProvider, form, onOpenChange],
  );

  const handleClose = useCallback(() => {
    form.reset();
    setActiveSection("general");
    onOpenChange(false);
  }, [form, onOpenChange]);

  const currentProviderType = form.watch("providerType");
  const navItems = useMemo(
    () => getIdentityProviderDialogNavItems(currentProviderType),
    [currentProviderType],
  );

  const validActiveSection = navItems.some((item) => item.id === activeSection)
    ? activeSection
    : "general";

  return (
    <IdentityProviderDialogShell
      open={open}
      onOpenChange={handleClose}
      title={
        providerName ? `Configure ${providerName}` : "Add Identity Provider"
      }
      description={
        providerName
          ? `Configure ${providerName} Single Sign-On for your organization.`
          : "Configure a new Single Sign-On provider for your organization."
      }
      providerLabel={providerName ?? "New provider"}
      form={form}
      activeSection={validActiveSection}
      navItems={navItems}
      onActiveSectionChange={setActiveSection}
      onSubmit={form.handleSubmit(onSubmit)}
      footer={
        <>
          <Button type="button" variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <PermissionButton
            type="submit"
            permissions={{ identityProvider: ["create"] }}
            disabled={createIdentityProvider.isPending}
            data-testid={E2eTestId.IdentityProviderCreateButton}
          >
            {createIdentityProvider.isPending
              ? "Creating..."
              : "Create Provider"}
          </PermissionButton>
        </>
      }
    >
      {currentProviderType === "saml" ? (
        <SamlConfigForm
          form={form}
          activeSection={
            validActiveSection as Exclude<
              IdentityProviderDialogSection,
              "enterprise-managed-credentials"
            >
          }
          hideProviderId={hideProviderId}
        />
      ) : (
        <OidcConfigForm
          form={form}
          activeSection={
            validActiveSection as Exclude<
              IdentityProviderDialogSection,
              "service-provider-metadata"
            >
          }
          hidePkce={hidePkce}
          hideProviderId={hideProviderId}
        />
      )}
    </IdentityProviderDialogShell>
  );
}
