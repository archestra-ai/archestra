"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SsoProviderFormSchema, type SsoProviderFormValues } from "@shared";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useDeleteSsoProvider,
  useSsoProvider,
  useUpdateSsoProvider,
} from "@/lib/sso-provider.query.ee";
import { OidcConfigForm } from "./oidc-config-form.ee";
import { SamlConfigForm } from "./saml-config-form.ee";

interface EditSsoProviderDialogProps {
  ssoProviderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditSsoProviderDialog({
  ssoProviderId,
  open,
  onOpenChange,
}: EditSsoProviderDialogProps) {
  const { data: provider, isLoading } = useSsoProvider(ssoProviderId);
  const updateSsoProvider = useUpdateSsoProvider();
  const deleteSsoProvider = useDeleteSsoProvider();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const form = useForm<SsoProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(SsoProviderFormSchema as any),
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
        // Include roleMapping and teamSyncConfig if they exist on the provider
        ...(provider.roleMapping && { roleMapping: provider.roleMapping }),
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
    async (data: SsoProviderFormValues) => {
      if (!provider) return;
      await updateSsoProvider.mutateAsync({
        id: provider.id,
        data,
      });
      onOpenChange(false);
    },
    [provider, updateSsoProvider, onOpenChange],
  );

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!provider) return;
    await deleteSsoProvider.mutateAsync(provider.id);
    setShowDeleteConfirm(false);
    onOpenChange(false);
  }, [provider, deleteSsoProvider, onOpenChange]);

  if (isLoading || !provider) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Edit SSO Provider</DialogTitle>
          <DialogDescription>
            Update the configuration for "{provider.providerId}".
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col flex-1 overflow-hidden"
          >
            <div className="flex-1 overflow-y-auto py-4">
              {providerType === "saml" ? (
                <SamlConfigForm form={form} />
              ) : (
                <OidcConfigForm form={form} />
              )}
            </div>

            <DialogFooter className="mt-4">
              <div className="flex w-full justify-between">
                <PermissionButton
                  type="button"
                  variant="destructive"
                  permissions={{ ssoProvider: ["delete"] }}
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
                    permissions={{ ssoProvider: ["update"] }}
                    disabled={updateSsoProvider.isPending}
                  >
                    {updateSsoProvider.isPending
                      ? "Updating..."
                      : "Update Provider"}
                  </PermissionButton>
                </div>
              </div>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SSO Provider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{provider.providerId}"? This
              action cannot be undone. Users will no longer be able to sign in
              using this provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <PermissionButton
              permissions={{ ssoProvider: ["delete"] }}
              onClick={handleDelete}
              disabled={deleteSsoProvider.isPending}
              variant="destructive"
            >
              {deleteSsoProvider.isPending ? "Deleting..." : "Delete"}
            </PermissionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
