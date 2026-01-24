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
import { PermissionButton } from "@/components/ui/permission-button";
import { useCreateSsoProvider } from "@/lib/sso-provider.query.ee";
import { OidcConfigForm } from "./oidc-config-form.ee";
import { SamlConfigForm } from "./saml-config-form.ee";

interface CreateSsoProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultValues?: Partial<SsoProviderFormValues>;
  providerName?: string;
  /** Hide the PKCE checkbox (for providers that don't support it like GitHub) */
  hidePkce?: boolean;
  /** Hide the Provider ID field (for predefined providers like Okta, Google, GitHub) */
  hideProviderId?: boolean;
  /** Provider type: oidc or saml */
  providerType?: "oidc" | "saml";
}

export function CreateSsoProviderDialog({
  open,
  onOpenChange,
  defaultValues,
  providerName,
  hidePkce,
  hideProviderId,
  providerType = "oidc",
}: CreateSsoProviderDialogProps) {
  const createSsoProvider = useCreateSsoProvider();

  const form = useForm<SsoProviderFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(SsoProviderFormSchema as any),
    defaultValues: defaultValues || {
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
    },
  });

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

  const currentProviderType = form.watch("providerType");

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {providerName ? `Configure ${providerName}` : "Add SSO Provider"}
          </DialogTitle>
          <DialogDescription>
            {providerName
              ? `Configure ${providerName} Single Sign-On for your organization.`
              : "Configure a new Single Sign-On provider for your organization."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col flex-1 overflow-hidden"
          >
            <div className="flex-1 overflow-y-auto py-4">
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

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <PermissionButton
                type="submit"
                permissions={{ ssoProvider: ["create"] }}
                disabled={createSsoProvider.isPending}
              >
                {createSsoProvider.isPending
                  ? "Creating..."
                  : "Create Provider"}
              </PermissionButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
