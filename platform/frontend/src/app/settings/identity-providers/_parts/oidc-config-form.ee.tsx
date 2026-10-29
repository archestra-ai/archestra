"use client";

import {
  type IdentityProviderFormValues,
  type IdentityProviderSecretPath,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { AllowedEmailDomainsField } from "./allowed-email-domains-field.ee";
import {
  type EnterpriseSubjectTokenType,
  getDefaultSubjectTokenType,
  getDefaultTokenEndpointAuthentication,
  inferEnterpriseExchangeType,
} from "./identity-provider-form.utils";
import { IdentityProviderSectionHeader } from "./identity-provider-section-header.ee";
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
    | "team-sync";
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

  const attributeMappingContent = (
    <div className="space-y-4">
      <IdentityProviderSectionHeader title="Attribute Mapping">
        Choose which sign-in claims supply each user’s profile.
      </IdentityProviderSectionHeader>
      <FormField
        control={form.control}
        name="oidcConfig.overrideUserInfo"
        render={({ field }) => (
          <FormItem className="flex flex-row items-start gap-2 space-y-0">
            <FormControl>
              <Checkbox
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            </FormControl>
            <div className="space-y-1">
              <FormLabel>Update profile on sign-in</FormLabel>
              <FormDescription className="text-xs">
                {field.value
                  ? "Update existing users’ names, emails, and photos using these claims."
                  : "Existing users keep their email, name, and photo. These profile mappings apply only to new users."}
              </FormDescription>
            </div>
          </FormItem>
        )}
      />
      <div className="grid gap-4 md:grid-cols-2">
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
    </div>
  );

  return (
    <div className="space-y-6">
      {(!activeSection || activeSection === "general") && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <IdentityProviderSectionHeader title="Provider Details">
              Identify this provider and choose who can sign in.
            </IdentityProviderSectionHeader>
          </div>
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

          <div className="md:col-span-2">
            <AllowedEmailDomainsField form={form} />
          </div>
          <div className="md:col-span-2">
            <SsoLoginEnabledField form={form} />
          </div>

          <Separator className="md:col-span-2" />

          <div className="md:col-span-2">
            <IdentityProviderSectionHeader title="OIDC Settings">
              Connect using your provider&apos;s client credentials and sign-in
              endpoints.
            </IdentityProviderSectionHeader>
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
              <FormItem className="md:col-span-2">
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

          <FormField
            control={form.control}
            name="oidcConfig.scopes"
            render={({ field }) => (
              <FormItem className="md:col-span-2">
                <FormLabel>Scopes</FormLabel>
                <FormDescription>
                  OAuth scopes to request. Choose common scopes or add your own.
                </FormDescription>
                <FormControl>
                  <SearchableMultiSelect
                    ariaLabel="Scopes"
                    value={field.value ?? []}
                    onValueChange={field.onChange}
                    items={Array.from(
                      new Set([
                        "openid",
                        "email",
                        "profile",
                        "groups",
                        "offline_access",
                        ...scopes,
                      ]),
                    ).map((scope) => ({ value: scope, label: scope }))}
                    allowCustom
                    searchPlaceholder="Search or add a scope..."
                    placeholder="Select scopes"
                    maxBadgeDisplay={3}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid items-start gap-x-4 gap-y-3 md:col-span-2 md:grid-cols-2">
            <div className="space-y-3">
              {!hidePkce && (
                <FormField
                  control={form.control}
                  name="oidcConfig.pkce"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start gap-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1">
                        <FormLabel>Enable PKCE</FormLabel>
                        <FormDescription className="text-xs">
                          Use Proof Key for Code Exchange for enhanced security.
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              )}
            </div>
            <div>
              <FormField
                control={form.control}
                name="oidcConfig.enableRpInitiatedLogout"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel>Enable RP-Initiated Logout</FormLabel>
                      <FormDescription className="text-xs">
                        Send the <code>post_logout_redirect_uri</code> parameter
                        during sign-out.{" "}
                        <ExternalDocsLink
                          href="https://openid.net/specs/openid-connect-rpinitiated-1_0.html"
                          className="underline underline-offset-4"
                        >
                          Learn more
                        </ExternalDocsLink>
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>
          </div>
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
  subjectTokenTypeDefault: EnterpriseSubjectTokenType;
  embedded?: boolean;
  /** See `OidcConfigForm`'s `configuredSecretPaths`. */
  isSecretStored: (path: IdentityProviderSecretPath) => boolean;
}) {
  const {
    authenticationDefault,
    form,
    subjectTokenTypeDefault,
    embedded = false,
    isSecretStored,
  } = props;
  const appName = useAppName();

  const content = (
    <>
      <IdentityProviderSectionHeader title="Tool Authentication">
        Let MCP tools act as the signed-in user through{" "}
        <ExternalDocsLink
          href="https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization"
          showIcon={false}
          className="underline underline-offset-4"
        >
          ID-JAG
        </ExternalDocsLink>{" "}
        or your provider&apos;s token exchange. Suggested defaults for your
        provider are selected below.
      </IdentityProviderSectionHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.clientId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Exchange Client ID</FormLabel>
              <FormDescription>
                Defaults to the OIDC Client ID used for sign-in.
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
                Required when using client secret authentication.
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
              Endpoint used to request access for tools. Leave empty to use your
              provider&apos;s default.
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

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.tokenEndpointAuthentication"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Exchange Client Authentication</FormLabel>
              <FormDescription>
                How {appName} authenticates to the token endpoint.
              </FormDescription>
              <Select
                value={field.value ?? authenticationDefault}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
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
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.subjectTokenType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>User&apos;s Token to Exchange</FormLabel>
              <FormDescription>
                The sign-in token used to request access for tools.
              </FormDescription>
              <Select
                value={field.value ?? subjectTokenTypeDefault}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
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
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.privateKeyId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Signing Key ID</FormLabel>
              <FormDescription>
                The key identifier registered with your identity provider.
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
                Audience for the signed request. Defaults to the token endpoint.
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
      </div>

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
