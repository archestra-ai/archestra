"use client";

import type { SsoProviderFormValues } from "@shared";
import { Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { RoleMappingForm } from "./role-mapping-form.ee";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

interface OidcConfigFormProps {
  form: UseFormReturn<SsoProviderFormValues>;
  /** Hide the PKCE checkbox (for providers that don't support it like GitHub) */
  hidePkce?: boolean;
  /** Hide the Provider ID field (for predefined providers like Okta, Google, GitHub) */
  hideProviderId?: boolean;
}

export function OidcConfigForm({
  form,
  hidePkce,
  hideProviderId,
}: OidcConfigFormProps) {
  const [newScope, setNewScope] = useState("");

  const scopes = form.watch("oidcConfig.scopes") || [];

  const addScope = useCallback(() => {
    if (newScope.trim() && !scopes.includes(newScope.trim())) {
      form.setValue("oidcConfig.scopes", [...scopes, newScope.trim()]);
      setNewScope("");
    }
  }, [newScope, scopes, form]);

  const removeScope = useCallback(
    (scopeToRemove: string) => {
      form.setValue(
        "oidcConfig.scopes",
        scopes.filter((scope) => scope !== scopeToRemove),
      );
    },
    [scopes, form],
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">SSO Provider Configuration</h3>
        <p className="text-sm text-muted-foreground">
          Configure your OpenID Connect provider settings.
        </p>
      </div>

      <div className="grid gap-4">
        {!hideProviderId && (
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
                  Unique identifier for this SSO provider. Used in callback
                  URLs.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="issuer"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Issuer</FormLabel>
              <FormControl>
                <Input placeholder="https://auth.company.com" {...field} />
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

        <Separator />

        <div>
          <h4 className="text-md font-medium mb-4">OIDC Settings</h4>
        </div>
        <FormField
          control={form.control}
          name="oidcConfig.clientId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Client ID</FormLabel>
              <FormControl>
                <Input placeholder="your-client-id" {...field} />
              </FormControl>
              <FormDescription>
                The client ID provided by your OIDC provider.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.clientSecret"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Client Secret</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder="your-client-secret"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The client secret provided by your OIDC provider.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.discoveryEndpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Discovery Endpoint</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://auth.company.com/.well-known/openid-configuration"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The OIDC discovery endpoint URL
                (/.well-known/openid-configuration).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.authorizationEndpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Authorization Endpoint (Optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://auth.company.com/authorize"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Override the authorization endpoint if not using discovery.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.tokenEndpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Token Endpoint (Optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://auth.company.com/token"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Override the token endpoint if not using discovery.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.userInfoEndpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>UserInfo Endpoint (Optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://auth.company.com/userinfo"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Override the userinfo endpoint if not using discovery.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.jwksEndpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>JWKS Endpoint (Optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://auth.company.com/.well-known/jwks.json"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Override the JWKS endpoint if not using discovery.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="space-y-3">
          <FormLabel>Scopes</FormLabel>
          <div className="flex gap-2">
            <Input
              placeholder="Add scope (e.g., profile)"
              value={newScope}
              onChange={(e) => setNewScope(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addScope();
                }
              }}
            />
            <Button
              type="button"
              onClick={addScope}
              size="icon"
              variant="outline"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {scopes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {scopes.map((scope) => (
                <Badge
                  key={scope}
                  variant="secondary"
                  className="flex items-center gap-1"
                >
                  {scope}
                  <button
                    type="button"
                    onClick={() => removeScope(scope)}
                    className="ml-1 hover:bg-destructive/20 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <FormDescription>
            OAuth scopes to request. Common scopes: openid, email, profile.
          </FormDescription>
        </div>

        {!hidePkce && (
          <FormField
            control={form.control}
            name="oidcConfig.pkce"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none">
                  <FormLabel>Enable PKCE</FormLabel>
                  <FormDescription>
                    Use Proof Key for Code Exchange for enhanced security.
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="oidcConfig.overrideUserInfo"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>Override User Info</FormLabel>
                <FormDescription>
                  Override user information with provider data on each login.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />
      </div>

      <Separator />

      <div>
        <h4 className="text-md font-medium mb-4">Attribute Mapping</h4>
        <div className="grid gap-4">
          <FormField
            control={form.control}
            name="oidcConfig.mapping.id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>User ID Claim</FormLabel>
                <FormControl>
                  <Input placeholder="sub" {...field} />
                </FormControl>
                <FormDescription>
                  The claim that contains the unique user identifier.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="oidcConfig.mapping.email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email Claim</FormLabel>
                <FormControl>
                  <Input placeholder="email" {...field} />
                </FormControl>
                <FormDescription>
                  The claim that contains the user's email address.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="oidcConfig.mapping.name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name Claim</FormLabel>
                <FormControl>
                  <Input placeholder="name" {...field} />
                </FormControl>
                <FormDescription>
                  The claim that contains the user's display name.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="oidcConfig.mapping.emailVerified"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email Verified Claim (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="email_verified" {...field} />
                </FormControl>
                <FormDescription>
                  The claim that indicates if the email is verified.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="oidcConfig.mapping.image"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Avatar Image Claim (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="picture" {...field} />
                </FormControl>
                <FormDescription>
                  The claim that contains the user's profile picture URL.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>

      <RoleMappingForm form={form} />

      <TeamSyncConfigForm form={form} />
    </div>
  );
}
