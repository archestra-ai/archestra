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
  // The tier is "free for < threshold users", so the free tier supports
  // threshold - 1 users (e.g. threshold 30 → "29-user free tier").
  const freeTierMax = tier.threshold - 1;

  return (
    <div className="mb-6 rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
      <p className="leading-relaxed">
        {bannerCopy({ tier, featureName, enabled, userWord, freeTierMax })}{" "}
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

function bannerCopy({
  tier,
  featureName,
  enabled,
  userWord,
  freeTierMax,
}: {
  tier: NonNullable<ReturnType<typeof useSmallTeamTier>>;
  featureName: string | undefined;
  enabled: boolean;
  userWord: string;
  freeTierMax: number;
}): string {
  if (featureName) {
    return enabled
      ? `${featureName} is an enterprise feature, enabled for this instance because you have ${tier.userCount} ${userWord} (within the ${freeTierMax}-user free tier).`
      : `${featureName} is an enterprise feature. Your instance has ${tier.userCount} ${userWord}, above the ${freeTierMax}-user free tier, so it is disabled until a license is activated.`;
  }
  return enabled
    ? `Your instance has ${tier.userCount} ${userWord} — within the ${freeTierMax}-user free tier. Enterprise features (RBAC, SSO, Knowledge Base with access control) are included.`
    : `Your instance has ${tier.userCount} ${userWord} — above the ${freeTierMax}-user free tier. Enterprise features (RBAC, SSO, Knowledge Base with access control) are disabled until a license is activated.`;
}
