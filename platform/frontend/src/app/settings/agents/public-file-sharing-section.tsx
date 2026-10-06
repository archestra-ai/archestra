"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PublicFileLinksList } from "@/components/public-file-links-list";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

/**
 * The organization switch for `share_file_publicly`, and the list of every
 * public link agents created, so an admin can see what is public and revoke it.
 */
export function PublicFileSharingSection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateSecuritySettings(
    "Public file sharing updated",
    "Failed to update public file sharing",
  );
  const enabled = organization?.allowPublicFileSharing ?? false;

  return (
    <SettingsBlock
      id="public-file-sharing"
      title="Public File Sharing"
      description={
        <>
          Let agents publish images, videos, and PDFs as public links that
          anyone can open without logging in — to hand an image to a social
          media scheduler, for example. Turning this off stops every existing
          link.{" "}
          <ExternalDocsLink
            href={getDocsUrl(
              DocsPage.PlatformCodeSandbox,
              "share-files-as-public-links",
            )}
            className="whitespace-nowrap"
          >
            Learn more
          </ExternalDocsLink>
        </>
      }
      control={
        <WithPermissions
          permissions={{ organizationSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <Switch
              aria-label="Allow agents to share files publicly"
              checked={enabled}
              disabled={
                !organization || !hasPermission || updateMutation.isPending
              }
              onCheckedChange={(checked) =>
                updateMutation.mutate({ allowPublicFileSharing: checked })
              }
            />
          )}
        </WithPermissions>
      }
    >
      <WithPermissions
        permissions={{ publicFileLink: ["admin"] }}
        noPermissionHandle="hide"
      >
        <PublicFileLinksList
          scope="organization"
          emptyText="No files have been shared publicly yet."
        />
      </WithPermissions>
    </SettingsBlock>
  );
}
