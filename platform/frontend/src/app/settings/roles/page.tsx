"use client";

import { E2eTestId } from "@archestra/shared";
import { Eye } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DisabledEnterpriseSection } from "@/components/disabled-enterprise-section";
import { QueryLoadError } from "@/components/query-load-error";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { Button } from "@/components/ui/button";
import { UserSearchableSelect } from "@/components/user-searchable-select";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import {
  useCanImpersonate,
  useImpersonateUser,
  useImpersonationCandidates,
} from "@/lib/impersonation.query";

const RolesListEnterprise = dynamic(() =>
  // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
  import("@/components/roles/roles-list.ee").then((m) => ({
    default: m.RolesList,
  })),
);

function RoleDebuggerCallout() {
  const canImpersonate = useCanImpersonate();
  const {
    data: candidates,
    isLoading,
    isLoadingError: isCandidatesLoadError,
    refetch: refetchCandidates,
  } = useImpersonationCandidates();
  const { mutate: impersonate, isPending } = useImpersonateUser();
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const userOptions = (candidates ?? []).map((candidate) => ({
    userId: candidate.id,
    name: candidate.role
      ? `${candidate.name} · ${candidate.role}`
      : candidate.name,
    email: candidate.email,
  }));

  if (!canImpersonate) return null;

  return (
    <div className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">Want to debug a role?</p>
      <p className="text-muted-foreground">
        Pick a user and view the app as them. The session expires after one hour
        or when you click <em>Return to admin</em> in the banner.
      </p>
      {isCandidatesLoadError ? (
        <QueryLoadError
          className="mt-3"
          title="Couldn't load users to impersonate"
          onRetry={() => refetchCandidates()}
        />
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <UserSearchableSelect
            value={selectedUserId}
            onValueChange={setSelectedUserId}
            users={userOptions}
            disabled={isLoading || !candidates || candidates.length === 0}
            placeholder={
              isLoading
                ? "Loading users..."
                : !candidates || candidates.length === 0
                  ? "No users available"
                  : "Select a user"
            }
            searchPlaceholder="Search users by name or email"
            className="w-72"
            emptyMessage="No matching users found."
          />
          <Button
            size="sm"
            variant="outline"
            data-testid={E2eTestId.ImpersonationViewAsButton}
            disabled={!selectedUserId || isPending}
            onClick={() => {
              if (selectedUserId) impersonate(selectedUserId);
            }}
          >
            <Eye className="mr-2 h-4 w-4" />
            View as user
          </Button>
        </div>
      )}
    </div>
  );
}

export default function RolesSettingsPage() {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner featureName="RBAC" />
      <RoleDebuggerCallout />
      <DisabledEnterpriseSection disabled={!enterpriseCoreActive}>
        <RolesListEnterprise />
      </DisabledEnterpriseSection>
    </ErrorBoundary>
  );
}
