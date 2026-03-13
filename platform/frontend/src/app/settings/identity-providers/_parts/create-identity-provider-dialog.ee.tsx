"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { useCallback } from "react";
import { useForm } from "react-hook-form";
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
import { useCreateIdentityProvider } from "@/lib/identity-provider.query.ee";
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

  const form = useForm<IdentityProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(IdentityProviderFormSchema as any),
    defaultValues: {
      roleMapping: { rules: [] },
      ...(defaultValues || {
        providerId: "",
        issuer: "",
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
            }),
      }),
    },
  });

  const onSubmit = useCallback(
    async (data: IdentityProviderFormValues) => {
      const result = await createIdentityProvider.mutateAsync(data);
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
    onOpenChange(false);
  }, [form, onOpenChange]);

  const currentProviderType = form.watch("providerType");

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {providerName
              ? `Configure ${providerName}`
              : "Add Identity Provider"}
          </DialogTitle>
          <DialogDescription>
            {providerName
              ? `Configure ${providerName} Single Sign-On for your organization.`
              : "Configure a new Single Sign-On provider for your organization."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            {currentProviderType === "saml" ? (
              <SamlConfigForm form={form} hideProviderId={hideProviderId} />
            ) : (
              <OidcConfigForm
                form={form}
                hidePkce={hidePkce}
                hideProviderId={hideProviderId}
              />
            )}

            <DialogStickyFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <PermissionButton
                type="submit"
                permissions={{ identityProvider: ["create"] }}
                disabled={createIdentityProvider.isPending}
              >
                {createIdentityProvider.isPending
                  ? "Creating..."
                  : "Create & Test"}
              </PermissionButton>
            </DialogStickyFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
