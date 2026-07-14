// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { useSmallTeamTier } from "@/lib/config/config.query";

const SALES_EMAIL = "sales@archestra.ai";

interface SmallTeamTierBannerProps {
  /**
   * Name of the enterprise feature this page covers (e.g. "SSO",
   * "Knowledge Base"). Omit on pages that show the banner without being an
   * enterprise feature themselves (e.g. Settings → Users, Settings →
   * Organization); in that case the banner lists the features generically.
   */
  featureName?: string;
}

export function SmallTeamTierBanner({ featureName }: SmallTeamTierBannerProps) {
  const tier = useSmallTeamTier();

  if (!tier || !tier.communicate) {
    return null;
  }

  const pricingUrl = getDocsUrl(DocsPage.PlatformPricingModel);
  const enabled = tier.smallTeam || tier.envFlag;
  const userWord = tier.userCount === 1 ? "user" : "users";

  return (
    <div className="mb-6 rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
      <p className="leading-relaxed">
        {bannerCopy({ tier, featureName, enabled, userWord })}{" "}
        <a
          href={`mailto:${SALES_EMAIL}`}
          className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
        >
          {SALES_EMAIL}
        </a>{" "}
        ·{" "}
        <a
          href={pricingUrl}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
        >
          Pricing
        </a>
      </p>
    </div>
  );
}

// The tier is "free for teams under <threshold> users" (strict comparison on
// the backend), so the copy phrases it the way the pricing model does instead
// of naming a max user count.
function bannerCopy({
  tier,
  featureName,
  enabled,
  userWord,
}: {
  tier: NonNullable<ReturnType<typeof useSmallTeamTier>>;
  featureName: string | undefined;
  enabled: boolean;
  userWord: string;
}): string {
  const freeTier = `the free tier for teams under ${tier.threshold} users`;
  if (featureName) {
    return enabled
      ? `${featureName} is an enterprise feature, enabled for this instance because you have ${tier.userCount} ${userWord} (within ${freeTier}).`
      : `${featureName} is an enterprise feature. Your instance has ${tier.userCount} ${userWord}, which exceeds ${freeTier}, so it is disabled until a license is activated.`;
  }
  return enabled
    ? `Your instance has ${tier.userCount} ${userWord} — within ${freeTier}. Enterprise features (RBAC, SSO, Knowledge Base with access control) are included.`
    : `Your instance has ${tier.userCount} ${userWord} — exceeding ${freeTier}. Enterprise features (RBAC, SSO, Knowledge Base with access control) are disabled until a license is activated.`;
}
