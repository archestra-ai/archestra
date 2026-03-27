"use client";

import type { IdentityProviderFormValues } from "@shared";
import { ExternalLink, Plus, X } from "lucide-react";
import Link from "next/link";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { RoleMappingForm } from "./role-mapping-form.ee";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

interface OidcConfigFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
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
      <div className="grid gap-4">
        {!hideProviderId && (
          <FormField
            control={form.control}
            name="providerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Provider ID</FormLabel>
                <FormControl>
                  <Input placeholder="my-company-idp" {...field} />
                </FormControl>
                <FormDescription>
                  Unique identifier for this identity provider. Used in callback
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

        <Separator />

        <div>
          <h4 className="text-md font-medium mb-4">
            Enterprise-Managed Credentials
          </h4>
          <p className="text-sm text-muted-foreground mb-4">
            Configure how this identity provider authenticates to the enterprise
            broker when a tool assignment uses enterprise-managed credentials.
          </p>
        </div>

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.providerType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Provider Type</FormLabel>
              <Select
                value={field.value ?? "okta"}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="okta">Okta</SelectItem>
                  <SelectItem value="keycloak">Keycloak</SelectItem>
                  <SelectItem value="generic_oidc">Generic OIDC</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                Select the enterprise broker implementation used for managed
                credential exchange.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.clientId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Broker Client ID</FormLabel>
              <FormControl>
                <Input placeholder="AI agent client ID" {...field} />
              </FormControl>
              <FormDescription>
                Optional override for the client ID used when Archestra calls
                the enterprise token exchange endpoint.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.tokenEndpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Broker Token Endpoint</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://your-okta-domain/oauth2/v1/token"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Optional override for the token exchange endpoint used for
                enterprise-managed credentials.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.tokenEndpointAuthentication"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Broker Client Authentication</FormLabel>
              <Select
                value={field.value ?? "private_key_jwt"}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="private_key_jwt">
                    Private key JWT
                  </SelectItem>
                  <SelectItem value="client_secret_post">
                    Client secret POST
                  </SelectItem>
                  <SelectItem value="client_secret_basic">
                    Client secret Basic
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                Okta AI agent registrations typically use private key JWT.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.clientSecret"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Broker Client Secret</FormLabel>
              <FormControl>
                <Input type="password" placeholder="Optional" {...field} />
              </FormControl>
              <FormDescription>
                Only used when the broker token endpoint authenticates with a
                client secret.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.privateKeyId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Broker Key ID</FormLabel>
              <FormControl>
                <Input placeholder="kid" {...field} />
              </FormControl>
              <FormDescription>
                Key ID used when signing private key JWT client assertions.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.clientAssertionAudience"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Client Assertion Audience</FormLabel>
              <FormControl>
                <Input
                  placeholder="Defaults to the broker token endpoint"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Optional audience override for private key JWT client
                assertions.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.subjectTokenType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Subject Token Type</FormLabel>
              <Select
                value={
                  field.value ?? "urn:ietf:params:oauth:token-type:id_token"
                }
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="urn:ietf:params:oauth:token-type:access_token">
                    Access token
                  </SelectItem>
                  <SelectItem value="urn:ietf:params:oauth:token-type:id_token">
                    ID token
                  </SelectItem>
                  <SelectItem value="urn:ietf:params:oauth:token-type:jwt">
                    Generic JWT
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                Most enterprise SSO flows should use the ID token as the subject
                token for managed credential exchange.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.privateKeyPem"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Broker Private Key PEM</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="min-h-32 font-mono text-xs"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Paste the AI agent registration private key used to sign client
                assertions.
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
          name="oidcConfig.enableRpInitiatedLogout"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>Enable RP-Initiated Logout</FormLabel>
                <FormDescription>
                  Send the <code>post_logout_redirect_uri</code> parameter
                  during sign-out.{" "}
                  <Link
                    href="https://openid.net/specs/openid-connect-rpinitiated-1_0.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-4"
                  >
                    Learn more
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

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
