"use client";

import {
  SSO_PROVIDER_ID,
  SSO_TRUSTED_PROVIDER_IDS,
  type SsoProviderId,
} from "@shared";
import { useCallback, useState } from "react";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { LoadingSpinner } from "@/components/loading";
import { SsoProviderIcon } from "@/components/sso-provider-icons.ee";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import config from "@/lib/config";
import { useSsoProviders } from "@/lib/sso-provider.query.ee";
import { CreateSsoProviderDialog } from "./create-sso-provider-dialog.ee";
import { EditSsoProviderDialog } from "./edit-sso-provider-dialog.ee";

/** Configuration for a predefined SSO provider card */
interface SsoProviderConfig {
  /** Internal ID for the config (used as React key) */
  id: string;
  /** Canonical provider ID used for registration and callbacks */
  providerId: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Tailwind background color class for the icon container */
  bgColor: string;
  /** Hide the provider ID field in the form (for predefined providers) */
  hideProviderId: boolean;
  /** Disable PKCE (for providers that don't support it like GitHub) */
  disablePkce?: boolean;
  /** Provider type: oidc or saml */
  providerType: "oidc" | "saml";
  /** Default OIDC configuration values (for OIDC providers) */
  defaultOidcConfig?: {
    issuer: string;
    discoveryEndpoint: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    userInfoEndpoint?: string;
    jwksEndpoint?: string;
    scopes: string[];
    mapping: {
      id: string;
      email: string;
      name: string;
    };
  };
  /** Default SAML configuration values (for SAML providers) */
  defaultSamlConfig?: {
    issuer: string;
    entryPoint: string;
    cert: string;
    callbackUrl: string;
    mapping?: {
      id?: string;
      email?: string;
      name?: string;
      firstName?: string;
      lastName?: string;
    };
  };
}

// Predefined SSO provider configurations
const SSO_PROVIDER_CONFIGS: SsoProviderConfig[] = [
  {
    id: "okta",
    // Use the canonical provider ID from shared constants
    providerId: SSO_PROVIDER_ID.OKTA,
    name: "Okta",
    description: "Enterprise identity and access management",
    bgColor: "bg-blue-50",
    // Hide the provider ID field for predefined providers
    hideProviderId: true,
    providerType: "oidc",
    defaultOidcConfig: {
      issuer: "https://your-domain.okta.com",
      discoveryEndpoint:
        "https://your-domain.okta.com/.well-known/openid-configuration",
      scopes: ["openid", "email", "profile"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "google",
    providerId: SSO_PROVIDER_ID.GOOGLE,
    name: "Google",
    description: "Sign in with Google OAuth",
    bgColor: "bg-red-50",
    hideProviderId: true,
    providerType: "oidc",
    defaultOidcConfig: {
      issuer: "https://accounts.google.com",
      discoveryEndpoint:
        "https://accounts.google.com/.well-known/openid-configuration",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      jwksEndpoint: "https://www.googleapis.com/oauth2/v3/certs",
      scopes: ["openid", "email", "profile"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    /**
     * GitHub OAuth limitation: Users must have a public email set in their
     * GitHub profile settings for SSO to work. This is because the SSO plugin
     * only calls /user endpoint, not /user/emails.
     * See: https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/github/
     */
    id: "github",
    providerId: SSO_PROVIDER_ID.GITHUB,
    name: "GitHub",
    description: "Sign in with GitHub OAuth (requires public email)",
    bgColor: "bg-gray-50",
    hideProviderId: true,
    providerType: "oidc",
    /**
     * GitHub doesn't support PKCE
     * https://github.com/orgs/community/discussions/15752
     */
    disablePkce: true,
    defaultOidcConfig: {
      issuer: "https://github.com",
      /**
       * GitHub OAuth doesn't have a standard OIDC discovery endpoint
       * https://stackoverflow.com/a/52164558
       * https://docs.github.com/en/actions/concepts/security/openid-connect
       */
      discoveryEndpoint: "",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userInfoEndpoint: "https://api.github.com/user",
      scopes: ["read:user", "user:email"],
      mapping: {
        id: "id",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "gitlab",
    providerId: SSO_PROVIDER_ID.GITLAB,
    name: "GitLab",
    description: "Sign in with GitLab OAuth",
    bgColor: "bg-orange-50",
    hideProviderId: true,
    providerType: "oidc",
    defaultOidcConfig: {
      issuer: "https://gitlab.com",
      discoveryEndpoint: "https://gitlab.com/.well-known/openid-configuration",
      authorizationEndpoint: "https://gitlab.com/oauth/authorize",
      tokenEndpoint: "https://gitlab.com/oauth/token",
      userInfoEndpoint: "https://gitlab.com/oauth/userinfo",
      jwksEndpoint: "https://gitlab.com/oauth/discovery/keys",
      scopes: ["openid", "email", "profile"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "entra",
    providerId: SSO_PROVIDER_ID.ENTRA_ID,
    name: "Microsoft Entra ID",
    description: "Sign in with Microsoft (Azure AD)",
    bgColor: "bg-sky-50",
    hideProviderId: true,
    providerType: "oidc",
    /**
     * Microsoft Entra ID (formerly Azure AD) configuration
     * Users need to replace {tenant-id} with their Azure tenant ID
     * See: https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/entraid/
     */
    defaultOidcConfig: {
      issuer: "https://login.microsoftonline.com/{tenant-id}/v2.0",
      discoveryEndpoint:
        "https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration",
      authorizationEndpoint:
        "https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/authorize",
      tokenEndpoint:
        "https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token",
      userInfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
      jwksEndpoint:
        "https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys",
      scopes: ["openid", "email", "profile"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "generic-oidc",
    // Generic OAuth allows custom provider IDs
    providerId: "",
    name: "Generic OIDC",
    description: "Configure any OpenID Connect provider",
    bgColor: "bg-purple-50",
    // Show the provider ID field for generic providers
    hideProviderId: false,
    providerType: "oidc",
    defaultOidcConfig: {
      issuer: "",
      discoveryEndpoint: "",
      scopes: ["openid", "email", "profile"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "generic-saml",
    // Generic SAML allows custom provider IDs
    providerId: "",
    name: "Generic SAML",
    description: "Configure any SAML 2.0 identity provider",
    bgColor: "bg-indigo-50",
    // Show the provider ID field for generic providers
    hideProviderId: false,
    providerType: "saml",
    defaultSamlConfig: {
      issuer: "",
      entryPoint: "",
      cert: "",
      callbackUrl: "",
      mapping: {
        id: "nameID",
        email: "email",
        name: "name",
        firstName: "firstName",
        lastName: "lastName",
      },
    },
  },
];

type SsoProvider = NonNullable<
  ReturnType<typeof useSsoProviders>["data"]
>[number];

export function SsoProvidersSettingsContent() {
  const { data: ssoProviders = [], isLoading } = useSsoProviders();
  const [createConfig, setCreateConfig] = useState<{
    providerId: string;
    config: SsoProviderConfig;
  } | null>(null);
  const [editingProvider, setEditingProvider] = useState<SsoProvider | null>(
    null,
  );

  // Find existing providers by matching provider ID
  const getProviderStatus = useCallback(
    (config: SsoProviderConfig) => {
      const provider = ssoProviders.find((p) => {
        // For predefined providers, match exactly by canonical provider ID
        if (config.providerId) {
          return p.providerId === config.providerId;
        }

        // For generic providers (empty providerId), match by provider type as well
        // Check if this is a non-trusted provider and matches the same type (OIDC vs SAML)
        const isNonTrustedProvider = !SSO_TRUSTED_PROVIDER_IDS.includes(
          p.providerId as SsoProviderId,
        );
        if (!isNonTrustedProvider) {
          return false;
        }

        // Determine provider type from config presence
        const existingProviderType = p.samlConfig ? "saml" : "oidc";
        return existingProviderType === config.providerType;
      });
      return provider;
    },
    [ssoProviders],
  );

  const handleProviderClick = useCallback(
    (config: SsoProviderConfig) => {
      const existingProvider = getProviderStatus(config);

      if (existingProvider) {
        // Edit existing provider
        setEditingProvider(existingProvider);
      } else {
        // Create new provider
        setCreateConfig({
          providerId: config.id,
          config,
        });
      }
    },
    [getProviderStatus],
  );

  // Show message if SSO feature is disabled (check before loading since query is disabled)
  if (!config.enterpriseLicenseActivated) {
    return (
      <div>
        <div className="mb-8">
          <h2 className="text-lg font-semibold">SSO Providers</h2>
          <EnterpriseLicenseRequired featureName="SSO (Single Sign-On)" />
        </div>
      </div>
    );
  }

  if (isLoading) return <LoadingSpinner />;

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-lg font-semibold">SSO Providers</h2>
        <p className="text-sm text-muted-foreground">
          Manage Single Sign-On (SSO) providers for your organization. Configure
          OIDC providers to enable seamless authentication.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {SSO_PROVIDER_CONFIGS.map((config) => {
          const existingProvider = getProviderStatus(config);

          return (
            <Card
              key={config.id}
              className="cursor-pointer hover:shadow-md transition-shadow flex flex-col h-full"
              onClick={() => handleProviderClick(config)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div
                    className={`p-2 rounded-lg ${config.bgColor} text-gray-900`}
                  >
                    <SsoProviderIcon
                      providerId={config.providerId || config.id}
                      size={24}
                    />
                  </div>
                  <Badge variant={existingProvider ? "default" : "secondary"}>
                    {existingProvider ? "Enabled" : "Not enabled"}
                  </Badge>
                </div>
                <CardTitle className="text-lg">{config.name}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col flex-1">
                <div className="flex-1 min-h-[2.5rem] flex flex-col justify-end mb-4">
                  <p className="text-sm text-muted-foreground">
                    {config.description}
                  </p>
                </div>
                <Button
                  variant={existingProvider ? "outline" : "default"}
                  size="sm"
                  className="w-full"
                >
                  {existingProvider ? "Configure" : "Enable"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Create Dialog */}
      {createConfig && (
        <CreateSsoProviderDialog
          open={!!createConfig}
          onOpenChange={(open) => !open && setCreateConfig(null)}
          defaultValues={
            createConfig.config.providerType === "saml"
              ? {
                  providerId: createConfig.config.providerId || "",
                  issuer: createConfig.config.defaultSamlConfig?.issuer || "",
                  domain: "",
                  providerType: "saml" as const,
                  samlConfig: {
                    issuer: createConfig.config.defaultSamlConfig?.issuer || "",
                    entryPoint:
                      createConfig.config.defaultSamlConfig?.entryPoint || "",
                    cert: createConfig.config.defaultSamlConfig?.cert || "",
                    callbackUrl:
                      createConfig.config.defaultSamlConfig?.callbackUrl ||
                      `${typeof window !== "undefined" ? window.location.origin : ""}/api/auth/sso/saml2/sp/acs/{providerId}`,
                    spMetadata: {},
                    mapping:
                      createConfig.config.defaultSamlConfig?.mapping || {},
                  },
                }
              : {
                  providerId: createConfig.config.providerId || "",
                  issuer: createConfig.config.defaultOidcConfig?.issuer || "",
                  domain: "",
                  providerType: "oidc" as const,
                  oidcConfig: {
                    ...createConfig.config.defaultOidcConfig,
                    issuer: createConfig.config.defaultOidcConfig?.issuer || "",
                    discoveryEndpoint:
                      createConfig.config.defaultOidcConfig
                        ?.discoveryEndpoint || "",
                    scopes: createConfig.config.defaultOidcConfig?.scopes || [
                      "openid",
                      "email",
                      "profile",
                    ],
                    mapping: createConfig.config.defaultOidcConfig?.mapping || {
                      id: "sub",
                      email: "email",
                      name: "name",
                    },
                    clientId: "",
                    clientSecret: "",
                    pkce: !createConfig.config.disablePkce,
                    overrideUserInfo: true,
                  },
                }
          }
          providerName={createConfig.config.name}
          hidePkce={createConfig.config.disablePkce}
          hideProviderId={createConfig.config.hideProviderId}
          providerType={createConfig.config.providerType}
        />
      )}

      {/* Edit Dialog */}
      {editingProvider && (
        <EditSsoProviderDialog
          ssoProviderId={editingProvider.id}
          open={!!editingProvider}
          onOpenChange={(open) => !open && setEditingProvider(null)}
        />
      )}
    </div>
  );
}
