"use client";

import {
  DocsPage,
  type IdentityProviderFormValues,
  type IdentityProviderSecretPath,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";
import { Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
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
import { SecretInput, SecretTextarea } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AllowedEmailDomainsField } from "./allowed-email-domains-field.ee";
import {
  type EnterpriseSubjectTokenType,
  getDefaultSubjectTokenType,
  getDefaultTokenEndpointAuthentication,
  inferEnterpriseExchangeType,
} from "./identity-provider-form.utils";
import { RoleMappingForm } from "./role-mapping-form.ee";
import { SsoLoginEnabledField } from "./sso-login-enabled-field.ee";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

const SUBJECT_TOKEN_LABEL_BY_TYPE = {
  [OAUTH_TOKEN_TYPE.AccessToken]: "Access token",
  [OAUTH_TOKEN_TYPE.IdToken]: "ID token",
  [OAUTH_TOKEN_TYPE.Jwt]: "Generic JWT",
} as const satisfies Record<EnterpriseSubjectTokenType, string>;

interface OidcConfigFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  activeSection?:
    | "general"
    | "attribute-mapping"
    | "enterprise-managed-credentials"
    | "role-mapping"
    | "team-sync"
    | "token-debugger";
  /** Hide the PKCE checkbox (for providers that don't support it like GitHub) */
  hidePkce?: boolean;
  /** Hide the Provider ID field (for predefined providers like Okta, Google, GitHub) */
  hideProviderId?: boolean;
  /**
   * Secret fields the server already holds a value for. Reads redact the values
   * themselves, so this is what lets a stored credential render as "stored,
   * leave blank to keep" instead of an empty box that looks wiped.
   */
  configuredSecretPaths?: IdentityProviderSecretPath[];
}

export function OidcConfigForm({
  form,
  identityProviderId,
  activeSection,
  hidePkce,
  hideProviderId,
  configuredSecretPaths,
}: OidcConfigFormProps) {
  const [newScope, setNewScope] = useState("");
  const isSecretStored = (path: IdentityProviderSecretPath) =>
    configuredSecretPaths?.includes(path) ?? false;

  const scopes = form.watch("oidcConfig.scopes") || [];
  const issuer = form.watch("issuer") || "";
  const providerId = form.watch("providerId") || "";
  const inferredEnterpriseExchangeType = inferEnterpriseExchangeType({
    issuer,
    providerId,
  });
  const authenticationDefault = getDefaultTokenEndpointAuthentication(
    inferredEnterpriseExchangeType,
  );
  const subjectTokenTypeDefault = getDefaultSubjectTokenType(
    inferredEnterpriseExchangeType,
  );

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

  const attributeMappingContent = (
    <div className="grid gap-4">
      <FormField
        control={form.control}
        name="oidcConfig.mapping.id"
        render={({ field }) => (
          <FormItem>
            <FormLabel>User ID Claim</FormLabel>
            <FormDescription>
              The claim that contains the unique user identifier.
            </FormDescription>
            <FormControl>
              <Input placeholder="sub" {...field} />
            </FormControl>
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
            <FormDescription>
              The claim that contains the user&apos;s email address.
            </FormDescription>
            <FormControl>
              <Input placeholder="email" {...field} />
            </FormControl>
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
            <FormDescription>
              The claim that contains the user&apos;s display name.
            </FormDescription>
            <FormControl>
              <Input placeholder="name" {...field} />
            </FormControl>
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
            <FormDescription>
              The claim that indicates if the email is verified.
            </FormDescription>
            <FormControl>
              <Input placeholder="email_verified" {...field} />
            </FormControl>
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
            <FormDescription>
              The claim that contains the user&apos;s profile picture URL.
            </FormDescription>
            <FormControl>
              <Input placeholder="picture" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      {(!activeSection || activeSection === "general") && (
        <div className="grid gap-4">
          {!hideProviderId && (
            <FormField
              control={form.control}
              name="providerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider ID</FormLabel>
                  <FormDescription>
                    Unique identifier for this identity provider. Used in
                    callback URLs.
                  </FormDescription>
                  <FormControl>
                    <Input placeholder="my-company-idp" {...field} />
                  </FormControl>
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
                <FormDescription>
                  The issuer URL of your identity provider.
                </FormDescription>
                <FormControl>
                  <Input placeholder="https://auth.company.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <SsoLoginEnabledField form={form} />
          <AllowedEmailDomainsField form={form} />

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
                <FormDescription>
                  The client ID provided by your OIDC provider.
                </FormDescription>
                <FormControl>
                  <Input placeholder="your-client-id" {...field} />
                </FormControl>
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
                <FormDescription>
                  The client secret provided by your OIDC provider.
                </FormDescription>
                <StoredSecretNote
                  stored={isSecretStored("oidcConfig.clientSecret")}
                />
                <FormControl>
                  <SecretInput
                    placeholder={
                      isSecretStored("oidcConfig.clientSecret")
                        ? STORED_SECRET_PLACEHOLDER
                        : "your-client-secret"
                    }
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {providerId === "Google" && (
            <FormField
              control={form.control}
              name="oidcConfig.hd"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hosted Domain Hint (Optional)</FormLabel>
                  <FormDescription>
                    Passes Google&apos;s `hd` parameter to prefer account
                    selection for a Workspace domain. This is a Google hint, not
                    the security boundary; sign-in is enforced by Allowed Email
                    Domains.
                  </FormDescription>
                  <FormControl>
                    <Input placeholder="example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="oidcConfig.discoveryEndpoint"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Discovery Endpoint (Optional)</FormLabel>
                <FormDescription>
                  The OIDC discovery endpoint URL
                  (/.well-known/openid-configuration). Defaults to the issuer's
                  well-known URL. Leave blank for providers that publish no
                  discovery document, and set the endpoints below instead.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://auth.company.com/.well-known/openid-configuration"
                    {...field}
                  />
                </FormControl>
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
                <FormDescription>
                  Override the authorization endpoint if not using discovery.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://auth.company.com/authorize"
                    {...field}
                  />
                </FormControl>
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
                <FormDescription>
                  Override the token endpoint if not using discovery.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://auth.company.com/token"
                    {...field}
                  />
                </FormControl>
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
                <FormDescription>
                  Override the userinfo endpoint if not using discovery.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://auth.company.com/userinfo"
                    {...field}
                  />
                </FormControl>
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
                <FormDescription>
                  Override the JWKS endpoint if not using discovery.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://auth.company.com/.well-known/jwks.json"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="space-y-3">
            <FormLabel>Scopes</FormLabel>
            <div className="flex gap-2">
              <Input
                aria-label="Add scope"
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
                aria-label="Add scope"
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
                      aria-label="Remove scope"
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
                    <ExternalDocsLink
                      href="https://openid.net/specs/openid-connect-rpinitiated-1_0.html"
                      className="inline-flex items-center gap-1 underline underline-offset-4"
                    >
                      Learn more
                    </ExternalDocsLink>
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
      )}

      {!activeSection && <Separator />}

      {(!activeSection || activeSection === "attribute-mapping") &&
        attributeMappingContent}

      {(!activeSection ||
        activeSection === "enterprise-managed-credentials") && (
        <EnterpriseManagedCredentialsForm
          authenticationDefault={authenticationDefault}
          form={form}
          inferredEnterpriseExchangeType={inferredEnterpriseExchangeType}
          subjectTokenTypeDefault={subjectTokenTypeDefault}
          embedded={!!activeSection}
          isSecretStored={isSecretStored}
        />
      )}

      {(!activeSection || activeSection === "role-mapping") && (
        <RoleMappingForm
          form={form}
          identityProviderId={identityProviderId}
          embedded={!!activeSection}
        />
      )}

      {(!activeSection || activeSection === "team-sync") && (
        <TeamSyncConfigForm
          form={form}
          identityProviderId={identityProviderId}
          embedded={!!activeSection}
        />
      )}
    </div>
  );
}

function EnterpriseManagedCredentialsForm(props: {
  authenticationDefault:
    | "private_key_jwt"
    | "client_secret_post"
    | "client_secret_basic";
  form: UseFormReturn<IdentityProviderFormValues>;
  inferredEnterpriseExchangeType: "okta_managed" | "rfc8693" | "entra_obo";
  subjectTokenTypeDefault: EnterpriseSubjectTokenType;
  embedded?: boolean;
  /** See `OidcConfigForm`'s `configuredSecretPaths`. */
  isSecretStored: (path: IdentityProviderSecretPath) => boolean;
}) {
  const {
    authenticationDefault,
    form,
    inferredEnterpriseExchangeType,
    subjectTokenTypeDefault,
    embedded = false,
    isSecretStored,
  } = props;
  const appName = useAppName();
  const identityProvidersDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformIdentityProviders,
  );

  const content = (
    <>
      <p className="text-sm text-muted-foreground">
        {`Leave this empty unless ${appName} should exchange the signed-in user's identity-provider token for a downstream tool token when tools run.`}
      </p>
      <p className="text-sm text-muted-foreground">
        {getEnterpriseExchangeHint(inferredEnterpriseExchangeType)}
        {identityProvidersDocsUrl ? (
          <>
            {" "}
            <ExternalDocsLink
              href={identityProvidersDocsUrl}
              className="inline-flex items-center gap-1 underline underline-offset-4"
            >
              Learn more
            </ExternalDocsLink>
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
              <FormDescription>
                Optional override. If empty, {appName} uses the main OIDC client
                ID above.
              </FormDescription>
              <FormControl>
                <Input
                  placeholder="Client ID used for token exchange"
                  {...field}
                />
              </FormControl>
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
              <FormDescription>
                Only used when the exchange endpoint authenticates with a client
                secret.
              </FormDescription>
              <StoredSecretNote
                stored={isSecretStored(
                  "oidcConfig.enterpriseManagedCredentials.clientSecret",
                )}
              />
              <FormControl>
                <SecretInput
                  placeholder={
                    isSecretStored(
                      "oidcConfig.enterpriseManagedCredentials.clientSecret",
                    )
                      ? STORED_SECRET_PLACEHOLDER
                      : "Optional"
                  }
                  {...field}
                />
              </FormControl>
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
            <FormDescription>
              Optional override for the token endpoint {appName} should call to
              exchange the user&apos;s token.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="https://your-idp.example.com/oauth2/v1/token"
                {...field}
              />
            </FormControl>
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
            <FormDescription>
              {getAuthenticationHint(inferredEnterpriseExchangeType)}
            </FormDescription>
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
                <SelectItem value="private_key_jwt">Private key JWT</SelectItem>
                <SelectItem value="client_secret_post">
                  Client secret POST
                </SelectItem>
                <SelectItem value="client_secret_basic">
                  Client secret Basic
                </SelectItem>
              </SelectContent>
            </Select>
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
            <FormDescription>
              Only used for <code>private_key_jwt</code> authentication.
            </FormDescription>
            <FormControl>
              <Input placeholder="kid" {...field} />
            </FormControl>
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
            <FormDescription>
              Optional override for <code>private_key_jwt</code> client
              assertions.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="Defaults to the exchange token endpoint"
                {...field}
              />
            </FormControl>
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
            <FormDescription>
              {getSubjectTokenHint(inferredEnterpriseExchangeType)}
            </FormDescription>
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
                {Object.entries(SUBJECT_TOKEN_LABEL_BY_TYPE).map(
                  ([tokenType, label]) => (
                    <SelectItem key={tokenType} value={tokenType}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
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
            <FormDescription>
              Only used for <code>private_key_jwt</code> authentication.
            </FormDescription>
            <StoredSecretNote
              stored={isSecretStored(
                "oidcConfig.enterpriseManagedCredentials.privateKeyPem",
              )}
            />
            <FormControl>
              <SecretTextarea
                placeholder={
                  isSecretStored(
                    "oidcConfig.enterpriseManagedCredentials.privateKeyPem",
                  )
                    ? STORED_SECRET_PLACEHOLDER
                    : "-----BEGIN PRIVATE KEY-----"
                }
                className="min-h-32 font-mono text-xs"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );

  return <div className={embedded ? "space-y-4" : "space-y-6"}>{content}</div>;
}

const STORED_SECRET_PLACEHOLDER = "••••••••";

/**
 * Explains why a saved secret shows up as an empty box. The value is redacted
 * server-side and never sent to the browser, so submitting the form unchanged
 * keeps whatever is stored.
 */
function StoredSecretNote({ stored }: { stored: boolean }) {
  if (!stored) return null;

  return (
    <FormDescription>
      A value is already stored. Leave blank to keep it, or enter a new value to
      replace.
    </FormDescription>
  );
}

function getEnterpriseExchangeHint(
  exchangeStrategy: "okta_managed" | "rfc8693" | "entra_obo",
): string {
  switch (exchangeStrategy) {
    case "okta_managed":
      return "For Okta, the suggested defaults are private key JWT client authentication and ID token exchange.";
    case "rfc8693":
      return "For this identity provider, the suggested defaults are RFC 8693 token exchange with client secret POST and access token exchange.";
    case "entra_obo":
      return "For Microsoft Entra ID, the suggested defaults are on-behalf-of with client secret POST and access token exchange.";
  }
}

function getAuthenticationHint(
  exchangeStrategy: "okta_managed" | "rfc8693" | "entra_obo",
): string {
  switch (exchangeStrategy) {
    case "okta_managed":
      return "Many enterprise exchanges use private key JWT here.";
    case "rfc8693":
      return "RFC 8693 token exchange commonly uses client secret POST here.";
    case "entra_obo":
      return "Microsoft Entra OBO commonly uses client secret POST here.";
  }
}

function getSubjectTokenHint(
  exchangeStrategy: "okta_managed" | "rfc8693" | "entra_obo",
): string {
  switch (exchangeStrategy) {
    case "okta_managed":
      return "The detected defaults prefer exchanging the user's ID token.";
    case "rfc8693":
      return "The detected defaults prefer exchanging the user's access token.";
    case "entra_obo":
      return "Microsoft Entra OBO expects the user's access token, not the ID token.";
  }
}
