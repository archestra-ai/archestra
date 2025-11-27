"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SsoProviderFormSchema, type SsoProviderFormValues } from "@shared";
import { useCallback } from "react";
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
import { useCreateSsoProvider } from "@/lib/sso-provider.query";
import { OidcConfigForm } from "./oidc-config-form";
import { SamlConfigForm } from "./saml-config-form";

interface CreateSsoProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateSsoProviderDialog({
  open,
  onOpenChange,
}: CreateSsoProviderDialogProps) {
  const createSsoProvider = useCreateSsoProvider();

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
      },
    },
  });

  const providerType = form.watch("providerType");

  const onSubmit = useCallback(
    async (data: SsoProviderFormValues) => {
      await createSsoProvider.mutateAsync(data);
      form.reset();
      onOpenChange(false);
    },
    [createSsoProvider, form, onOpenChange],
  );

  const handleClose = useCallback(() => {
    form.reset();
    onOpenChange(false);
  }, [form, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add SSO Provider</DialogTitle>
          <DialogDescription>
            Configure a new Single Sign-On provider for your organization.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col flex-1 overflow-hidden"
          >
            <div className="flex-1 overflow-y-auto py-4">
              <div className="space-y-4 mt-0">
                {providerType === "oidc" && <OidcConfigForm form={form} />}
                {providerType === "saml" && <SamlConfigForm form={form} />}
              </div>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSsoProvider.isPending}>
                {createSsoProvider.isPending
                  ? "Creating..."
                  : "Create Provider"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
