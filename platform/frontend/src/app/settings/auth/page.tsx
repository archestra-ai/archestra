"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import {
  SettingsCardHeader,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { Card } from "@/components/ui/card";
import { Form, FormField } from "@/components/ui/form";
import { RoleSelect } from "@/components/ui/role-select";
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useDisableBasicAuth,
  useEnterpriseFeature,
} from "@/lib/config/config.query";
import {
  useOrganization,
  useUpdateAuthSettings,
} from "@/lib/organization.query";
// biome-ignore lint/style/noRestrictedImports: dual-licensed; reset is a no-op when RUM never started
import { rumClient } from "@/lib/rum.ee";
import {
  type AuthSettingsFormValues,
  buildAuthSettingsFormValues,
  getSelectedOauthLifetimeSeconds,
  getSelectedSessionLifetimeSeconds,
  getServerOauthLifetimeSeconds,
} from "./_components/auth-settings-form";
import { OAuthTokenLifetimeSection } from "./_components/oauth-token-lifetime-section";
import { OrganizationTokenSection } from "./_components/organization-token-section";
import { SessionLifetimeSection } from "./_components/session-lifetime-section";

export default function AuthSettingsPage() {
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const { data: session } = useSession();
  const updateAuthSettingsMutation = useUpdateAuthSettings(
    "Auth settings updated",
    "Failed to update Auth settings",
  );
  const enterpriseCoreActive = useEnterpriseFeature("core");
  // Enrollment confirms a password, so a password-less (SSO-only) deployment
  // cannot satisfy the requirement — the backend refuses it too.
  const isBasicAuthDisabled = useDisableBasicAuth() === true;

  const serverValues = buildAuthSettingsFormValues(organization);
  const serverOauthLifetimeSeconds =
    getServerOauthLifetimeSeconds(organization);
  const serverSessionMaxAgeSeconds = organization?.sessionMaxAgeSeconds ?? null;

  const form = useForm<AuthSettingsFormValues>({
    defaultValues: buildAuthSettingsFormValues(organization),
    mode: "onChange",
  });

  useEffect(() => {
    if (!organization) {
      return;
    }
    form.reset(buildAuthSettingsFormValues(organization));
  }, [form, organization]);

  /**
   * Diff a form snapshot against the server values, keeping only real
   * changes so one save PATCHes exactly the dirty auth fields. Also derives
   * the save bar's dirty state (from the watched values) — and, because the
   * submit handler diffs the values react-hook-form passes at submit time, a
   * cancel-reset never reaches the API.
   */
  function computeAuthSettingsPatch(
    values: AuthSettingsFormValues,
  ): archestraApiTypes.UpdateAuthSettingsData["body"] {
    const data: archestraApiTypes.UpdateAuthSettingsData["body"] = {};
    if (isOrganizationPending) {
      return data;
    }

    const oauthLifetimeSeconds = getSelectedOauthLifetimeSeconds({
      oauthLifetimePreset:
        values.oauthLifetimePreset || serverValues.oauthLifetimePreset,
      oauthCustomLifetimeSeconds: values.oauthCustomLifetimeSeconds,
    });
    if (
      Number.isFinite(oauthLifetimeSeconds) &&
      oauthLifetimeSeconds !== serverOauthLifetimeSeconds
    ) {
      data.oauthAccessTokenLifetimeSeconds = oauthLifetimeSeconds;
    }

    // Enterprise-only policies are hidden without a license, so their
    // (unchanged) form values must never leak into the PATCH body.
    if (enterpriseCoreActive) {
      const sessionMaxAgeSeconds = getSelectedSessionLifetimeSeconds(values);
      if (sessionMaxAgeSeconds !== serverSessionMaxAgeSeconds) {
        data.sessionMaxAgeSeconds = sessionMaxAgeSeconds;
      }
      if (values.requireTwoFactor !== serverValues.requireTwoFactor) {
        data.requireTwoFactor = values.requireTwoFactor;
      }
    }

    if (values.defaultMemberRole !== serverValues.defaultMemberRole) {
      data.defaultMemberRole = values.defaultMemberRole;
    }

    return data;
  }

  const watchedValues = form.watch();
  const pendingPatch = computeAuthSettingsPatch(watchedValues);
  const hasChanges = Object.keys(pendingPatch).length > 0;
  const currentOauthLifetimeSeconds = getSelectedOauthLifetimeSeconds({
    oauthLifetimePreset:
      watchedValues.oauthLifetimePreset || serverValues.oauthLifetimePreset,
    oauthCustomLifetimeSeconds: watchedValues.oauthCustomLifetimeSeconds,
  });

  async function handleSave(values: AuthSettingsFormValues) {
    const data = computeAuthSettingsPatch(values);
    if (Object.keys(data).length === 0) {
      return;
    }

    const updatedOrganization =
      await updateAuthSettingsMutation.mutateAsync(data);
    if (!updatedOrganization) {
      return;
    }

    // Turning the requirement on revokes every non-enrolled member's session
    // server-side — including this one. Sign out cleanly (the cookie cache
    // would otherwise keep the dead session alive for up to a minute) and
    // send the admin through sign-in, which lands on the enrollment page.
    if (data.requireTwoFactor === true && !session?.user.twoFactorEnabled) {
      // Direct sign-out (bypasses /auth/sign-out): tear down RUM state the
      // same way that page does.
      rumClient.reset();
      await authClient.signOut();
      window.location.assign("/auth/sign-in");
      return;
    }

    form.reset(buildAuthSettingsFormValues(updatedOrganization));
  }

  function handleCancel() {
    form.reset(buildAuthSettingsFormValues(organization));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSave)} noValidate>
        <SettingsSectionStack>
          <SmallTeamTierBanner />
          <OAuthTokenLifetimeSection form={form} />

          {/* Enterprise-only auth policies are hidden (not greyed out)
              without a license; the API refuses the writes regardless. */}
          {enterpriseCoreActive && (
            <>
              <Card>
                <SettingsCardHeader
                  title="Require Two-Factor Authentication"
                  description={
                    isBasicAuthDisabled
                      ? "Unavailable while email/password sign-in is disabled: enrolling in 2FA requires confirming a password, so requiring it would lock every member out. Enforce multi-factor authentication at your identity provider instead."
                      : "Every member must enroll in 2FA. Turning this on signs out members who haven't enrolled; their next sign-in requires setup before anything else."
                  }
                  action={
                    <FormField
                      control={form.control}
                      name="requireTwoFactor"
                      render={({ field }) => (
                        <Switch
                          id="requireTwoFactor"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={isBasicAuthDisabled}
                        />
                      )}
                    />
                  }
                />
              </Card>

              <SessionLifetimeSection form={form} />
            </>
          )}

          <Card>
            <SettingsCardHeader
              title="Default Role for New Users"
              description="Role assigned to users who join via email/password self-signup or ChatOps auto-provisioning. SSO users are governed by their identity provider's role mapping."
              action={
                <FormField
                  control={form.control}
                  name="defaultMemberRole"
                  render={({ field }) => (
                    <RoleSelect
                      id="defaultMemberRole"
                      value={field.value}
                      onValueChange={field.onChange}
                      data-testid="default-member-role-select"
                      className="w-40"
                    />
                  )}
                />
              }
            />
          </Card>

          <OrganizationTokenSection />

          {/* Single save bar: every dirty auth field lands in one PATCH. */}
          <SettingsSaveBar
            hasChanges={hasChanges}
            isSaving={updateAuthSettingsMutation.isPending}
            permissions={{ organizationSettings: ["update"] }}
            onSave={form.handleSubmit(handleSave)}
            onCancel={handleCancel}
            disabledSave={
              !form.formState.isValid ||
              !Number.isFinite(currentOauthLifetimeSeconds)
            }
          />
        </SettingsSectionStack>
      </form>
    </Form>
  );
}
