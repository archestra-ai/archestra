"use client";

import { Github, Globe, Shield } from "lucide-react";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSsoProviders } from "@/lib/sso-provider.query";
import { CreateSsoProviderDialog } from "./_parts/create-sso-provider-dialog";
import { EditSsoProviderDialog } from "./_parts/edit-sso-provider-dialog";

// Predefined SSO provider configurations
const SSO_PROVIDER_CONFIGS = [
  {
    id: "okta",
    name: "Okta",
    description: "Enterprise identity and access management",
    icon: Shield,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    defaultConfig: {
      issuer: "https://your-domain.okta.com",
      discoveryEndpoint: "https://your-domain.okta.com/.well-known/openid-configuration",
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
    name: "Google",
    description: "Sign in with Google OAuth",
    icon: Globe,
    color: "text-red-600",
    bgColor: "bg-red-50",
    defaultConfig: {
      issuer: "https://accounts.google.com",
      discoveryEndpoint: "https://accounts.google.com/.well-known/openid-configuration",
      scopes: ["openid", "email", "profile"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Sign in with GitHub OAuth",
    icon: Github,
    color: "text-gray-800",
    bgColor: "bg-gray-50",
    defaultConfig: {
      issuer: "https://github.com",
      discoveryEndpoint: "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
      scopes: ["openid", "user:email", "read:user"],
      mapping: {
        id: "sub",
        email: "email",
        name: "name",
      },
    },
  },
  {
    id: "generic",
    name: "Generic OAuth",
    description: "Configure any OpenID Connect provider",
    icon: Globe,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    defaultConfig: {
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
];

type SsoProvider = NonNullable<ReturnType<typeof useSsoProviders>["data"]>[number];

function SsoProvidersSettingsContent() {
  const { data: ssoProviders = [], isLoading } = useSsoProviders();
  const [createConfig, setCreateConfig] = useState<{
    providerId: string;
    config: typeof SSO_PROVIDER_CONFIGS[0];
  } | null>(null);
  const [editingProvider, setEditingProvider] = useState<SsoProvider | null>(null);

  // Find existing providers by matching provider ID patterns
  const getProviderStatus = (configId: string) => {
    const provider = ssoProviders.find((p) => {
      // Match by provider ID patterns
      if (configId === "okta" && p.providerId.toLowerCase().includes("okta")) return true;
      if (configId === "google" && p.providerId.toLowerCase().includes("google")) return true;
      if (configId === "github" && p.providerId.toLowerCase().includes("github")) return true;
      if (configId === "generic" && 
          !p.providerId.toLowerCase().includes("okta") &&
          !p.providerId.toLowerCase().includes("google") &&
          !p.providerId.toLowerCase().includes("github")) return true;
      return false;
    });
    return provider;
  };

  const handleProviderClick = (config: typeof SSO_PROVIDER_CONFIGS[0]) => {
    const existingProvider = getProviderStatus(config.id);
    
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
  };

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">SSO Providers</h1>
        <p className="text-muted-foreground mt-2">
          Manage Single Sign-On (SSO) providers for your organization. Configure OIDC providers to enable seamless authentication.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {SSO_PROVIDER_CONFIGS.map((config) => {
          const existingProvider = getProviderStatus(config.id);
          const Icon = config.icon;
          
          return (
            <Card 
              key={config.id} 
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => handleProviderClick(config)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className={`p-2 rounded-lg ${config.bgColor}`}>
                    <Icon className={`h-6 w-6 ${config.color}`} />
                  </div>
                  <Badge variant={existingProvider ? "default" : "secondary"}>
                    {existingProvider ? "Enabled" : "Not enabled"}
                  </Badge>
                </div>
                <CardTitle className="text-lg">{config.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  {config.description}
                </p>
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
          defaultValues={{
            providerId: `${createConfig.config.name.toLowerCase()}-sso`,
            issuer: createConfig.config.defaultConfig.issuer,
            domain: "", // User needs to fill this
            providerType: "oidc" as const,
            oidcConfig: {
              ...createConfig.config.defaultConfig,
              clientId: "",
              clientSecret: "",
              pkce: true,
              overrideUserInfo: true,
            },
          }}
          providerName={createConfig.config.name}
        />
      )}

      {/* Edit Dialog */}
      {editingProvider && (
        <EditSsoProviderDialog
          provider={editingProvider}
          open={!!editingProvider}
          onOpenChange={(open) => !open && setEditingProvider(null)}
        />
      )}
    </div>
  );
}

export default function SsoProvidersSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SsoProvidersSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}