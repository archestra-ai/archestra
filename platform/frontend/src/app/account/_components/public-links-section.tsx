"use client";

import { PublicFileLinksList } from "@/components/public-file-links-list";
import { SettingsSection } from "@/components/settings-section";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { usePublicFileLinks } from "@/lib/public-file-links.query";

/**
 * Files your agents published as public links, so you can copy a link again
 * or take one down. Shown only once you have shared something: the agent tells
 * you when it publishes, so an empty section would only add noise.
 */
export function PublicLinksSection() {
  const sandboxEnabled = useFeature("sandbox") === true;
  const { data: canRead } = useHasPermissions({ publicFileLink: ["read"] });
  const enabled = sandboxEnabled && canRead === true;
  const { data } = usePublicFileLinks({
    scope: "mine",
    limit: 1,
    offset: 0,
    enabled,
  });
  if (!enabled || !data || data.pagination.total === 0) return null;

  return (
    <SettingsSection
      id="public-links"
      title="Public links"
      description="Files your agents published for you. Anyone with a link can open the file until you revoke it."
    >
      <PublicFileLinksList scope="mine" emptyText="" />
    </SettingsSection>
  );
}
