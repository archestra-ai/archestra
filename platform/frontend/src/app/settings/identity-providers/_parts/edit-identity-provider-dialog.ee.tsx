"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  E2eTestId,
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useDeleteIdentityProvider,
  useIdentityProvider,
  useUpdateIdentityProvider,
} from "@/lib/auth/identity-provider.query.ee";
import { getIdentityProviderDialogNavItems } from "./identity-provider-dialog-nav-items.ee";
import {
  type IdentityProviderDialogSection,
  IdentityProviderDialogShell,
} from "./identity-provider-dialog-shell.ee";
import { normalizeIdentityProviderFormValues } from "./identity-provider-form.utils";
import { OidcConfigForm } from "./oidc-config-form.ee";
import { SamlConfigForm } from "./saml-config-form.ee";

interface EditIdentityProviderDialogProps {
  identityProviderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditIdentityProviderDialog({
  identityProviderId,
  open,
  onOpenChange,
}: EditIdentityProviderDialogProps) {
  const { data: provider, isLoading } = useIdentityProvider(identityProviderId);
  const updateIdentityProvider = useUpdateIdentityProvider();
  const deleteIdentityProvider = useDeleteIdentityProvider();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activeSection, setActiveSection] =
    useState<IdentityProviderDialogSection>("general");

  const form = useForm<IdentityProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(IdentityProviderFormSchema as any),
    defaultValues: {
      providerId: "",
      issuer: "",
      ssoLoginEnabled: true,
      domain: "",
      providerType: "oidc",
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
      roleMapping: {
        rules: [],
      },
    },
  });

  // Determine provider type based on config presence
  const providerType = provider?.samlConfig ? "saml" : "oidc";

  useEffect(() => {
    if (provider) {
      const isSaml = !!provider.samlConfig;
      form.reset({
        providerId: provider.providerId,
        issuer: provider.issuer,
        ssoLoginEnabled: provider.ssoLoginEnabled ?? true,
        domain: provider.domain,
        providerType: isSaml ? "saml" : "oidc",
        roleMapping: {
          rules: [],
          ...provider.roleMapping,
        },
        ...(provider.teamSyncConfig && {
          teamSyncConfig: provider.teamSyncConfig,
        }),
        ...(isSaml
          ? {
              samlConfig: provider.samlConfig || {
                issuer: "",
                entryPoint: "",
                cert: "",
                callbackUrl: "",
                spMetadata: {},
                idpMetadata: {},
                mapping: {
                  id: "",
                  email: "email",
                  name: "",
                  firstName: "firstName",
                  lastName: "lastName",
                },
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
                ...provider.oidcConfig,
              },
            }),
      });
    }
  }, [provider, form]);

  const onSubmit = useCallback(
    async (data: IdentityProviderFormValues) => {
      if (!provider) return;
      const result = await updateIdentityProvider.mutateAsync({
        id: provider.id,
        data: normalizeIdentityProviderFormValues(data),
      });
      // Only close the dialog if update succeeded (result is not null)
      if (result) {
        onOpenChange(false);
      }
    },
    [provider, updateIdentityProvider, onOpenChange],
  );

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!provider) return;
    await deleteIdentityProvider.mutateAsync(provider.id);
    setShowDeleteConfirm(false);
    onOpenChange(false);
  }, [provider, deleteIdentityProvider, onOpenChange]);

  if (isLoading || !provider) {
    return null;
  }

  const navItems = getIdentityProviderDialogNavItems(providerType);
  const validActiveSection = navItems.some((item) => item.id === activeSection)
    ? activeSection
    : "general";

  return (
    <>
      <IdentityProviderDialogShell
        open={open}
        onOpenChange={handleClose}
        title="Edit Identity Provider"
        description={`Update the configuration for "${provider.providerId}".`}
        providerLabel={provider.providerId}
        form={form}
        activeSection={validActiveSection}
        navItems={navItems}
        onActiveSectionChange={setActiveSection}
        onSubmit={form.handleSubmit(onSubmit)}
        sidebarFooter={
          <PermissionButton
            type="button"
            variant="ghost"
            permissions={{ identityProvider: ["delete"] }}
            className="w-full justify-start gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setShowDeleteConfirm(true)}
            data-testid={E2eTestId.IdentityProviderDeleteButton}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </PermissionButton>
        }
        footer={
          <>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <PermissionButton
              type="submit"
              permissions={{ identityProvider: ["update"] }}
              disabled={updateIdentityProvider.isPending}
              data-testid={E2eTestId.IdentityProviderUpdateButton}
            >
              {updateIdentityProvider.isPending
                ? "Updating..."
                : "Update Provider"}
            </PermissionButton>
          </>
        }
      >
        {providerType === "saml" ? (
          <SamlConfigForm
            form={form}
            identityProviderId={provider.id}
            activeSection={
              validActiveSection as Exclude<
                IdentityProviderDialogSection,
                "enterprise-managed-credentials"
              >
            }
          />
        ) : (
          <OidcConfigForm
            form={form}
            identityProviderId={provider.id}
            activeSection={
              validActiveSection as Exclude<
                IdentityProviderDialogSection,
                "service-provider-metadata"
              >
            }
          />
        )}
      </IdentityProviderDialogShell>

      <DeleteConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Identity Provider"
        description={`Are you sure you want to delete "${provider.providerId}"? This action cannot be undone. Users will no longer be able to sign in using this provider.`}
        isPending={deleteIdentityProvider.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
