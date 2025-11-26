"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SsoProvider } from "@shared";

const ssoProviderFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    type: z.enum(["oidc", "saml"]),
    enabled: z.boolean().default(true),
    // OIDC fields
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    issuer: z.string().optional(),
    authorizationEndpoint: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    userInfoEndpoint: z.string().optional(),
    scopes: z.string().optional(),
    callbackUrl: z.string().optional(),
    // SAML fields
    entryPoint: z.string().optional(),
    cert: z.string().optional(),
    // Attribute mapping
    attributeMapping: z
      .object({
        email: z.string().optional(),
        name: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        organizationId: z.string().optional(),
        organizationName: z.string().optional(),
      })
      .optional(),
    // Advanced config
    advancedConfig: z.record(z.unknown()).optional(),
  })
  .refine(
    (data) => {
      if (data.type === "oidc") {
        return !!(
          data.clientId && data.clientSecret && data.issuer
        );
      }
      return true;
    },
    {
      message: "OIDC providers require clientId, clientSecret, and issuer",
      path: ["clientId"],
    },
  )
  .refine(
    (data) => {
      if (data.type === "saml") {
        return !!(data.entryPoint && data.cert);
      }
      return true;
    },
    {
      message: "SAML providers require entryPoint and cert",
      path: ["entryPoint"],
    },
  );

type SsoProviderFormData = z.infer<typeof ssoProviderFormSchema>;

interface SsoProviderFormProps {
  initialData?: SsoProvider;
  onSubmit: (data: SsoProviderFormData) => Promise<void>;
  onCancel: () => void;
  isLoading?: boolean;
}

export function SsoProviderForm({
  initialData,
  onSubmit,
  onCancel,
  isLoading = false,
}: SsoProviderFormProps) {
  const [activeTab, setActiveTab] = useState<"basic" | "mapping" | "advanced">(
    "basic",
  );

  const form = useForm<SsoProviderFormData>({
    resolver: zodResolver(ssoProviderFormSchema),
    defaultValues: {
      name: initialData?.name || "",
      type: initialData?.type || "oidc",
      enabled: initialData?.enabled ?? true,
      clientId: initialData?.clientId || "",
      clientSecret: initialData?.clientSecret || "",
      issuer: initialData?.issuer || "",
      authorizationEndpoint: initialData?.authorizationEndpoint || "",
      tokenEndpoint: initialData?.tokenEndpoint || "",
      userInfoEndpoint: initialData?.userInfoEndpoint || "",
      scopes: initialData?.scopes || "openid profile email",
      callbackUrl: initialData?.callbackUrl || "",
      entryPoint: initialData?.entryPoint || "",
      cert: initialData?.cert || "",
      attributeMapping: initialData?.attributeMapping || {
        email: "email",
        name: "name",
      },
      advancedConfig: initialData?.advancedConfig || {},
    },
  });

  const providerType = form.watch("type");

  const handleSubmit = async (data: SsoProviderFormData) => {
    // Clean up empty strings and undefined values
    const cleanedData: any = {
      name: data.name,
      type: data.type,
      enabled: data.enabled,
      attributeMapping: data.attributeMapping,
      advancedConfig: data.advancedConfig,
    };

    if (data.type === "oidc") {
      cleanedData.clientId = data.clientId;
      cleanedData.clientSecret = data.clientSecret;
      cleanedData.issuer = data.issuer;
      if (data.authorizationEndpoint)
        cleanedData.authorizationEndpoint = data.authorizationEndpoint;
      if (data.tokenEndpoint) cleanedData.tokenEndpoint = data.tokenEndpoint;
      if (data.userInfoEndpoint)
        cleanedData.userInfoEndpoint = data.userInfoEndpoint;
      if (data.scopes) cleanedData.scopes = data.scopes;
      if (data.callbackUrl) cleanedData.callbackUrl = data.callbackUrl;
    } else if (data.type === "saml") {
      cleanedData.entryPoint = data.entryPoint;
      cleanedData.cert = data.cert;
    }

    await onSubmit(cleanedData);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="mapping">Attribute Mapping</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="My SSO Provider"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    A friendly name to identify this provider
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
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
                      <SelectItem value="oidc">OIDC</SelectItem>
                      <SelectItem value="saml">SAML</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Choose between OIDC (OpenID Connect) or SAML 2.0
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Enabled</FormLabel>
                    <FormDescription>
                      Enable or disable this SSO provider
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            {providerType === "oidc" && (
              <>
                <FormField
                  control={form.control}
                  name="clientId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client ID</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="clientSecret"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client Secret</FormLabel>
                      <FormControl>
                        <Input type="password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="issuer"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Issuer URL</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://your-idp.com"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        The OIDC issuer URL (usually ends with /.well-known/openid-configuration)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="authorizationEndpoint"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Authorization Endpoint (Optional)</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormDescription>
                        Auto-discovered from issuer if not provided
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="tokenEndpoint"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Token Endpoint (Optional)</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormDescription>
                        Auto-discovered from issuer if not provided
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="userInfoEndpoint"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>UserInfo Endpoint (Optional)</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormDescription>
                        Auto-discovered from issuer if not provided
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="scopes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scopes</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="openid profile email"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Space-separated list of OAuth scopes
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {providerType === "saml" && (
              <>
                <FormField
                  control={form.control}
                  name="entryPoint"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SAML Entry Point</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://your-idp.com/sso/saml"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="cert"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>X.509 Certificate</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="-----BEGIN CERTIFICATE-----..."
                          className="font-mono text-xs"
                          rows={6}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        The X.509 certificate for SAML signature verification
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="mapping" className="space-y-4">
            <div className="text-sm text-muted-foreground mb-4">
              Map attributes from your identity provider to user fields. Use
              dot notation for nested attributes (e.g., &quot;user.email&quot;).
            </div>

            <FormField
              control={form.control}
              name="attributeMapping.email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email Attribute</FormLabel>
                  <FormControl>
                    <Input placeholder="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="attributeMapping.name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name Attribute</FormLabel>
                  <FormControl>
                    <Input placeholder="name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="attributeMapping.firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>First Name Attribute (Optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="given_name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="attributeMapping.lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last Name Attribute (Optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="family_name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </TabsContent>

          <TabsContent value="advanced" className="space-y-4">
            <div className="text-sm text-muted-foreground mb-4">
              Advanced configuration options. These are stored as JSON and
              passed directly to the SSO provider configuration.
            </div>
            <FormField
              control={form.control}
              name="callbackUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Callback URL (Optional)</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormDescription>
                    Custom callback URL. If not provided, a default will be used.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? "Saving..." : initialData ? "Update" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
