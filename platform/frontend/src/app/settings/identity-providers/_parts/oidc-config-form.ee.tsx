"use client";

import {
  DocsPage,
  type IdentityProviderFormValues,
  isOktaHostname,
} from "@shared";
import { ExternalLink, Info, Plus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
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
  const issuer = form.watch("issuer") || "";
  const providerId = form.watch("providerId") || "";

  const inferredEnterpriseExchangeType = inferEnterpriseExchangeType({
    issuer,
    providerId,
  });
  const authenticationDefault =
    inferredEnterpriseExchangeType === "keycloak"
      ? "client_secret_post"
      : "private_key_jwt";
  const subjectTokenTypeDefault =
    inferredEnterpriseExchangeType === "keycloak"
      ? "urn:ietf:params:oauth:token-type:access_token"
      : "urn:ietf:params:oauth:token-type:id_token";

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

      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="attribute-mapping" className="border-none">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <h4 className="text-md font-medium">
                Attribute Mapping (Optional)
              </h4>
            </div>
          </AccordionTrigger>
          <AccordionContent className="pt-4">
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
                      The claim that contains the user&apos;s email address.
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
                      The claim that contains the user&apos;s display name.
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
                      The claim that contains the user&apos;s profile picture
                      URL.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <EnterpriseManagedCredentialsForm
        authenticationDefault={authenticationDefault}
        form={form}
        inferredEnterpriseExchangeType={inferredEnterpriseExchangeType}
        subjectTokenTypeDefault={subjectTokenTypeDefault}
      />

      <RoleMappingForm form={form} />

      <TeamSyncConfigForm form={form} />
    </div>
  );
}

function EnterpriseManagedCredentialsForm(props: {
  authenticationDefault:
    | "private_key_jwt"
    | "client_secret_post"
    | "client_secret_basic";
  form: UseFormReturn<IdentityProviderFormValues>;
  inferredEnterpriseExchangeType: "okta" | "keycloak" | "generic_oidc";
  subjectTokenTypeDefault:
    | "urn:ietf:params:oauth:token-type:access_token"
    | "urn:ietf:params:oauth:token-type:id_token"
    | "urn:ietf:params:oauth:token-type:jwt";
}) {
  const {
    authenticationDefault,
    form,
    inferredEnterpriseExchangeType,
    subjectTokenTypeDefault,
  } = props;
  const identityProvidersDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformIdentityProviders,
  );

  return (
    <div className="space-y-6">
      <Separator />

      <Accordion type="single" collapsible className="w-full">
        <AccordionItem
          value="enterprise-managed-credentials"
          className="border-none"
        >
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <h4 className="text-md font-medium">
                Enterprise-Managed Credentials (Optional)
              </h4>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    <p>
                      Configure how Archestra exchanges a user&apos;s
                      identity-provider token for a downstream tool credential
                      at call-time.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pt-4">
            <p className="text-sm text-muted-foreground">
              Leave this empty unless agents or MCP gateways should resolve
              downstream tool credentials through this identity provider.
            </p>
            <p className="text-sm text-muted-foreground">
              Archestra applies sensible exchange defaults from the issuer URL.
              {getEnterpriseExchangeHint(inferredEnterpriseExchangeType)}
              {identityProvidersDocsUrl ? (
                <>
                  {" "}
                  <Link
                    href={identityProvidersDocsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-4"
                  >
                    Learn more
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </>
              ) : null}
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="oidcConfig.enterpriseManagedCredentials.clientId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Exchange Client ID</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Client ID used for token exchange"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Optional override. If empty, Archestra uses the main OIDC
                      client ID above.
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
                    <FormLabel>Exchange Client Secret</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder="Optional"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Only used when the exchange endpoint authenticates with a
                      client secret.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="oidcConfig.enterpriseManagedCredentials.tokenEndpoint"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Exchange Token Endpoint</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://your-idp.example.com/oauth2/v1/token"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional override for the token endpoint Archestra should
                    call to exchange the user&apos;s token.
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
                  <FormLabel>Exchange Client Authentication</FormLabel>
                  <Select
                    value={field.value ?? authenticationDefault}
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
                    {getAuthenticationHint(inferredEnterpriseExchangeType)}
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
                  <FormLabel>Signing Key ID</FormLabel>
                  <FormControl>
                    <Input placeholder="kid" {...field} />
                  </FormControl>
                  <FormDescription>
                    Only used for <code>private_key_jwt</code> authentication.
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
                  <FormLabel>Client Assertion Audience (Optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Defaults to the exchange token endpoint"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional override for <code>private_key_jwt</code> client
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
                  <FormLabel>User Token To Exchange</FormLabel>
                  <Select
                    value={field.value ?? subjectTokenTypeDefault}
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
                    {getSubjectTokenHint(inferredEnterpriseExchangeType)}
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
                  <FormLabel>Private Key PEM</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="-----BEGIN PRIVATE KEY-----"
                      className="min-h-32 font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Only used for <code>private_key_jwt</code> authentication.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function inferEnterpriseExchangeType(params: {
  issuer: string;
  providerId: string;
}): "okta" | "keycloak" | "generic_oidc" {
  const providerId = params.providerId.toLowerCase();
  const issuerUrl = tryParseUrl(params.issuer);

  if (
    isOktaHostname(issuerUrl?.hostname ?? "") ||
    providerId.includes("okta")
  ) {
    return "okta";
  }

  if (
    issuerUrl?.pathname.includes("/realms/") ||
    providerId.includes("keycloak")
  ) {
    return "keycloak";
  }

  return "generic_oidc";
}

function getEnterpriseExchangeHint(
  providerType: "okta" | "keycloak" | "generic_oidc",
): string {
  switch (providerType) {
    case "okta":
      return " The detected defaults prefer private key JWT client authentication and ID token exchange.";
    case "keycloak":
      return " The detected defaults prefer client secret POST and access token exchange.";
    default:
      return " Review the client authentication method and subject token type expected by your identity provider.";
  }
}

function getAuthenticationHint(
  providerType: "okta" | "keycloak" | "generic_oidc",
): string {
  switch (providerType) {
    case "okta":
      return "Many enterprise exchanges use private key JWT here.";
    case "keycloak":
      return "Many token-exchange flows use client secret POST here.";
    default:
      return "Choose the client authentication method required by your identity provider.";
  }
}

function getSubjectTokenHint(
  providerType: "okta" | "keycloak" | "generic_oidc",
): string {
  switch (providerType) {
    case "okta":
      return "The detected defaults prefer exchanging the user's ID token.";
    case "keycloak":
      return "The detected defaults prefer exchanging the user's access token.";
    default:
      return "Choose the user token type your identity provider expects for token exchange.";
  }
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
