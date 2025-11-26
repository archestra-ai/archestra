"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { archestraApiSdk } from "@shared";

export function SsoSignInButtons() {
  // For sign-in page, we need to get SSO providers without organization context
  // This is a simplified approach - in production, you might want organization selection
  const { data: providers, isLoading } = useQuery({
    queryKey: ["ssoProviders", "public"],
    queryFn: async () => {
      try {
        const { data } = await archestraApiSdk.getSsoProviders();
        return data || [];
      } catch (error) {
        // If not authenticated, return empty array
        return [];
      }
    },
    retry: false,
  });

  const [loadingProviderId, setLoadingProviderId] = useState<string | null>(null);

  const enabledProviders = providers?.filter((p) => p.enabled) || [];

  if (isLoading) {
    return null; // Don't show loading state on sign-in page
  }

  if (enabledProviders.length === 0) {
    return null;
  }

  const handleSsoSignIn = async (providerId: string) => {
    setLoadingProviderId(providerId);
    try {
      // Redirect to SSO authentication endpoint
      const response = await fetch(`/api/auth/sso/sign-in/${providerId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.url) {
          window.location.href = data.url;
        }
      } else {
        throw new Error("Failed to initiate SSO sign-in");
      }
    } catch (error) {
      console.error("SSO sign-in error:", error);
      setLoadingProviderId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in with SSO</CardTitle>
        <CardDescription>
          Use your organization&apos;s single sign-on provider
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {enabledProviders.map((provider) => (
          <Button
            key={provider.id}
            variant="outline"
            className="w-full"
            onClick={() => handleSsoSignIn(provider.id)}
            disabled={loadingProviderId !== null}
          >
            {loadingProviderId === provider.id ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              `Sign in with ${provider.name}`
            )}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
