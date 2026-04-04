"use client";

import { RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useSetSettingsAction } from "@/app/settings/layout";
import {
  SettingsCardHeader,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useCheckSecretsConnectivity,
  useSecretsType,
} from "@/lib/secrets.query";

export default function SecretsSettingsPage() {
  const setActionButton = useSetSettingsAction();
  const { data: secretsType, isLoading } = useSecretsType();
  const checkConnectivityMutation = useCheckSecretsConnectivity();

  const handleCheckConnectivity = useCallback(async () => {
    await checkConnectivityMutation.mutateAsync();
  }, [checkConnectivityMutation]);

  useEffect(() => {
    if (secretsType?.type !== "Vault") {
      setActionButton(null);
      return;
    }

    setActionButton(
      <PermissionButton
        permissions={{ secret: ["update"] }}
        onClick={handleCheckConnectivity}
        disabled={checkConnectivityMutation.isPending}
      >
        {checkConnectivityMutation.isPending && (
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        )}
        Check Vault Connectivity
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [
    checkConnectivityMutation.isPending,
    secretsType?.type,
    setActionButton,
    handleCheckConnectivity,
  ]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-lg text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Don't render anything if not using Vault storage
  if (secretsType?.type !== "Vault") {
    return null;
  }

  return (
    <SettingsSectionStack>
      <Card>
        <SettingsCardHeader
          title={
            <span className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Secrets Storage
            </span>
          }
        />
        <CardContent className="space-y-4">
          <div className="text-sm font-mono bg-muted p-3 rounded space-y-1">
            {Object.entries(secretsType.meta).map(([key, value]) => (
              <p key={key}>
                <span className="text-muted-foreground">{key}:</span> {value}
              </p>
            ))}
          </div>

          {checkConnectivityMutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Connection Failed</AlertTitle>
              <AlertDescription>
                {checkConnectivityMutation.error?.message ||
                  "Failed to connect to Vault"}
              </AlertDescription>
            </Alert>
          )}

          {checkConnectivityMutation.isSuccess &&
            checkConnectivityMutation.data && (
              <Alert>
                <AlertTitle>Connection Successful</AlertTitle>
                <AlertDescription>
                  Found {checkConnectivityMutation.data.secretCount} secret
                  {checkConnectivityMutation.data.secretCount === 1 ? "" : "s"}.
                </AlertDescription>
              </Alert>
            )}
        </CardContent>
      </Card>
    </SettingsSectionStack>
  );
}
