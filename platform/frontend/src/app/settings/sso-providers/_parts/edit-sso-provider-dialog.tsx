"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SsoProviderFormSchema, type SsoProviderFormValues } from "@shared";
import { useCallback, useEffect } from "react";
import { useForm } from "react-hook-form";
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
import { useSsoProvider, useUpdateSsoProvider } from "@/lib/sso-provider.query";
import { OidcConfigForm } from "./oidc-config-form";

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

  const form = useForm<SsoProviderFormValues>({
    resolver: zodResolver(SsoProviderFormSchema),
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

  useEffect(() => {
    if (provider) {
      form.reset({
        providerId: provider.providerId,
        issuer: provider.issuer,
        domain: provider.domain,
        providerType: "oidc", // Fixed to OIDC
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
              <OidcConfigForm form={form} />
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateSsoProvider.isPending}>
                {updateSsoProvider.isPending
                  ? "Updating..."
                  : "Update Provider"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
