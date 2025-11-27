"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SsoProviderFormSchema, type SsoProviderFormValues } from "@shared";
import { useCallback, useEffect, useState } from "react";
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type useSsoProviders,
  useUpdateSsoProvider,
} from "@/lib/sso-provider.query";
import { OidcConfigForm } from "./oidc-config-form";
import { SamlConfigForm } from "./saml-config-form";

interface EditSsoProviderDialogProps {
  provider: NonNullable<ReturnType<typeof useSsoProviders>["data"]>[number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditSsoProviderDialog({
  provider,
  open,
  onOpenChange,
}: EditSsoProviderDialogProps) {
  const [activeTab, setActiveTab] = useState("basic");
  const updateSsoProvider = useUpdateSsoProvider();

  const providerType = provider.oidcConfig ? "oidc" : "saml";

  const form = useForm<SsoProviderFormValues>({
    resolver: zodResolver(SsoProviderFormSchema),
    defaultValues: {
      providerId: provider.providerId,
      issuer: provider.issuer,
      domain: provider.domain,
      providerType,
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
      },
      samlConfig: provider.samlConfig,
    },
  });

  // Reset form when provider changes
  useEffect(() => {
    form.reset({
      providerId: provider.providerId,
      issuer: provider.issuer,
      domain: provider.domain,
      providerType,
      oidcConfig: provider.oidcConfig,
      samlConfig: provider.samlConfig,
    });
  }, [provider, providerType, form]);

  const watchedProviderType = form.watch("providerType");

  const onSubmit = useCallback(
    async (data: SsoProviderFormValues) => {
      await updateSsoProvider.mutateAsync({
        id: provider.id,
        data,
      });
      onOpenChange(false);
    },
    [provider.id, updateSsoProvider, onOpenChange],
  );

  const handleClose = useCallback(() => {
    setActiveTab("basic");
    onOpenChange(false);
  }, [onOpenChange]);

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
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="flex flex-col flex-1 overflow-hidden"
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="basic">Basic Configuration</TabsTrigger>
                <TabsTrigger value="advanced">
                  Provider Configuration
                </TabsTrigger>
              </TabsList>

              <div className="flex-1 overflow-y-auto py-4">
                <TabsContent value="basic" className="space-y-4 mt-0">
                  <FormField
                    control={form.control}
                    name="providerId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Provider ID</FormLabel>
                        <FormControl>
                          <Input placeholder="my-company-sso" {...field} />
                        </FormControl>
                        <FormDescription>
                          Unique identifier for this SSO provider. Used in
                          callback URLs.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="issuer"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Issuer</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://auth.company.com"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          The issuer URL of your identity provider.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="domain"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Domain</FormLabel>
                        <FormControl>
                          <Input placeholder="company.com" {...field} />
                        </FormControl>
                        <FormDescription>
                          Email domain for automatic provider detection.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="providerType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Provider Type</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select provider type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="oidc">
                              OpenID Connect (OIDC)
                            </SelectItem>
                            <SelectItem value="saml">SAML 2.0</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          Choose the authentication protocol your provider
                          supports.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </TabsContent>

                <TabsContent value="advanced" className="space-y-4 mt-0">
                  {watchedProviderType === "oidc" && (
                    <OidcConfigForm form={form} />
                  )}
                  {watchedProviderType === "saml" && (
                    <SamlConfigForm form={form} />
                  )}
                </TabsContent>
              </div>
            </Tabs>

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
