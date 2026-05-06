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
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useDeleteIdentityProvider,
  useIdentityProvider,
  useUpdateIdentityProvider,
} from "@/lib/auth/identity-provider.query.ee";
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

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={handleClose}
        title="Edit Identity Provider"
        description={`Update the configuration for "${provider.providerId}".`}
        size="large"
      >
        <Form {...form}>
          <DialogForm
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <DialogBody className="pb-4">
              {providerType === "saml" ? (
                <SamlConfigForm form={form} />
              ) : (
                <OidcConfigForm form={form} />
              )}
            </DialogBody>

            <DialogStickyFooter className="mt-0 sm:justify-between">
              <PermissionButton
                type="button"
                variant="destructive"
                permissions={{ identityProvider: ["delete"] }}
                className="sm:mr-auto"
                onClick={() => setShowDeleteConfirm(true)}
                data-testid={E2eTestId.IdentityProviderDeleteButton}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </PermissionButton>
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
            </DialogStickyFooter>
          </DialogForm>
        </Form>
      </FormDialog>

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
