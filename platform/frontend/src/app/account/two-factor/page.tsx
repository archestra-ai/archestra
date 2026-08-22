"use client";

import { TwoFactorCard } from "@/app/account/_components/two-factor-card";
import { useOrganization } from "@/lib/organization.query";

export default function AccountTwoFactorPage() {
  const { data: organization } = useOrganization();
  return <TwoFactorCard required={organization?.requireTwoFactor ?? false} />;
}
