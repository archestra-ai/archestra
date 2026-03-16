"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdentityProviderFormSchema,
  type IdentityProviderFormValues,
} from "@shared";
import { useCallback } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
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
    <FormDialog
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
      size="large"
      className="max-w-4xl"
    >
      <Form {...form}>
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {currentProviderType === "saml" ? (
              <SamlConfigForm form={form} hideProviderId={hideProviderId} />
            ) : (
              <OidcConfigForm
                form={form}
                hidePkce={hidePkce}
                hideProviderId={hideProviderId}
              />
            )}
          </div>

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
        </DialogForm>
      </Form>
    </FormDialog>
  );
}
