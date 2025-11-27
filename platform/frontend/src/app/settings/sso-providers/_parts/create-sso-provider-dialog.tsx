"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SsoProviderFormSchema, type SsoProviderFormValues } from "@shared";
import { useCallback, useState } from "react";
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
  const [activeTab, setActiveTab] = useState("basic");
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
    setActiveTab("basic");
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
                          defaultValue={field.value}
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
                  {providerType === "oidc" && <OidcConfigForm form={form} />}
                  {providerType === "saml" && <SamlConfigForm form={form} />}
                </TabsContent>
              </div>
            </Tabs>

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
