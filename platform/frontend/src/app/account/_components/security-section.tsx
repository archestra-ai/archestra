"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AccountRow,
  AccountRows,
} from "@/app/account/_components/account-rows";
import { ChangePasswordDialog } from "@/app/account/_components/change-password-dialog";
import { GatewayTokenRow } from "@/app/account/_components/gateway-token-row";
import { TwoFactorRow } from "@/app/account/_components/two-factor-row";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * How you sign in, and the credential your tools present as you. Password
 * only appears where the deployment uses passwords at all — with basic auth
 * off, sign-in belongs to the identity provider.
 */
export function SecuritySection() {
  const { data: organization } = useOrganization();
  const { data: publicConfig, isLoading } = usePublicConfig();
  const showPassword = !isLoading && !(publicConfig?.disableBasicAuth ?? false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const highlight = useSearchParams().get("highlight");

  // `/account?highlight=change-password` is where the default-credentials
  // warning sends an admin still on the seeded password.
  useEffect(() => {
    if (highlight === "change-password" && showPassword) {
      setIsChangePasswordOpen(true);
    }
  }, [highlight, showPassword]);

  return (
    <SettingsSection title="Sign-in & security">
      <AccountRows label="Sign-in and security">
        {showPassword && (
          <AccountRow
            label="Password"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsChangePasswordOpen(true)}
              >
                Change
              </Button>
            }
          >
            <span aria-hidden className="tracking-widest text-muted-foreground">
              ••••••••
            </span>
          </AccountRow>
        )}
        <TwoFactorRow required={organization?.requireTwoFactor ?? false} />
        <GatewayTokenRow />
      </AccountRows>
      {showPassword && (
        <ChangePasswordDialog
          open={isChangePasswordOpen}
          onOpenChange={setIsChangePasswordOpen}
        />
      )}
    </SettingsSection>
  );
}
