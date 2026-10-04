"use client";

import { TwoFactorCard } from "@/app/account/_components/two-factor-card";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";
import { SettingsSectionStack } from "@/components/settings/settings-block";
import { useOrganization } from "@/lib/organization.query";

export default function AccountAuthPage() {
  const { data: organization } = useOrganization();
  return (
    <SettingsSectionStack>
      <PersonalTokenCard />
      <TwoFactorCard required={organization?.requireTwoFactor ?? false} />
    </SettingsSectionStack>
  );
}
