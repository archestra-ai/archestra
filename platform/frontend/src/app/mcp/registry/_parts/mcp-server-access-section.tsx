"use client";

import { grantsAudience } from "@archestra/shared";
import { AudienceChip } from "@/components/audience-chip";
import { ResourcePermissions } from "@/components/resource-permissions";
import { SettingsSection } from "@/components/settings-section";
import { useResourcePermissions } from "@/lib/resource-permissions.query";

export const MCP_ACCESS_SECTION_ID = "access";

/**
 * Who can see, use and change an MCP server, as one section of its Overview.
 *
 * The editor sits in the content column with no heading of its own, and its
 * Save/Discard row only exists while there is a draft, right under the list
 * being edited.
 */
export function McpServerAccessSection({
  catalogId,
  memberView,
  onDirtyChange,
}: {
  catalogId: string;
  memberView: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  // Same query key as the editor below, so this costs no extra request. The
  // chip reads the saved grants: it states what is true now, not the draft.
  const { data: policy } = useResourcePermissions("mcpRegistry", catalogId);
  const audience = policy ? grantsAudience(policy.grants) : null;

  return (
    <SettingsSection
      id={MCP_ACCESS_SECTION_ID}
      className="scroll-mt-24"
      title="Access"
      description={
        memberView
          ? "Who you’ve shared this server with."
          : "Who can see, use, and change this server."
      }
      headerExtra={
        audience && !memberView ? (
          <AudienceChip audience={audience} className="mt-1" />
        ) : null
      }
    >
      {/* The inline Save row is the editor's own; a hairline makes it read as
          the foot of the list rather than another grant. */}
      <div className="[&_[data-section-actions]]:border-t [&_[data-section-actions]]:border-border/60 [&_[data-section-actions]]:pt-3">
        <ResourcePermissions
          resource="mcpRegistry"
          scope={catalogId}
          embedded
          standalone
          title={null}
          hideAudience
          memberView={memberView}
          onDirtyChange={onDirtyChange}
        />
      </div>
    </SettingsSection>
  );
}
