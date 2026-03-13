"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useDeleteIdentityProvider,
  useIdentityProvider,
  useUpdateIdentityProvider,
} from "@/lib/identity-provider.query.ee";
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
      domain: "",
      providerType: "oidc",
      oidcConfig: {
        issuer: "",
        pkce: true,
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
              oidcConfig: provider.oidcConfig || {
                issuer: "",
                pkce: true,
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
      });
    }
  }, [provider, form]);

  const onSubmit = useCallback(
    async (data: IdentityProviderFormValues) => {
      if (!provider) return;
      const result = await updateIdentityProvider.mutateAsync({
        id: provider.id,
        data,
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
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Identity Provider</DialogTitle>
          <DialogDescription>
            Update the configuration for "{provider.providerId}".
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            {providerType === "saml" ? (
              <SamlConfigForm form={form} />
            ) : (
              <OidcConfigForm form={form} />
            )}

            <DialogStickyFooter>
              <div className="flex w-full justify-between">
                <PermissionButton
                  type="button"
                  variant="destructive"
                  permissions={{ identityProvider: ["delete"] }}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </PermissionButton>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={handleClose}>
                    Cancel
                  </Button>
                  <PermissionButton
                    type="submit"
                    permissions={{ identityProvider: ["update"] }}
                    disabled={updateIdentityProvider.isPending}
                  >
                    {updateIdentityProvider.isPending
                      ? "Updating..."
                      : "Update Provider"}
                  </PermissionButton>
                </div>
              </div>
            </DialogStickyFooter>
          </form>
        </Form>
      </DialogContent>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Identity Provider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{provider.providerId}"? This
              action cannot be undone. Users will no longer be able to sign in
              using this provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <PermissionButton
              permissions={{ identityProvider: ["delete"] }}
              onClick={handleDelete}
              disabled={deleteIdentityProvider.isPending}
              variant="destructive"
            >
              {deleteIdentityProvider.isPending ? "Deleting..." : "Delete"}
            </PermissionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
