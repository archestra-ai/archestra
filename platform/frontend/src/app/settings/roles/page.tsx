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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

/**
 * Compact dialog entry point for the role debugger, sitting opposite the roles
 * search field rather than in a full-width callout, so the page leads with the
 * roles themselves.
 */
function RoleDebuggerDialog() {
  const canImpersonate = useCanImpersonate();
  const [open, setOpen] = useState(false);
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
  // A single-user organization has nobody to impersonate, so the trigger would
  // only ever open onto an empty picker. Errors keep it visible: hiding then
  // would make a failed fetch look like an empty org.
  if (!isLoading && !isCandidatesLoadError && userOptions.length === 0) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          data-testid={E2eTestId.ImpersonationDebugRoleButton}
        >
          <Eye className="mr-2 h-4 w-4" />
          <span>Debug a role</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>View the app as another user</DialogTitle>
          <DialogDescription>
            The impersonated session expires after one hour or when you click{" "}
            <em>Return to admin</em> in the banner.
          </DialogDescription>
        </DialogHeader>
        {isCandidatesLoadError ? (
          <QueryLoadError
            title="Couldn't load users to impersonate"
            onRetry={() => refetchCandidates()}
          />
        ) : (
          <div className="flex items-center gap-2">
            <UserSearchableSelect
              value={selectedUserId}
              onValueChange={setSelectedUserId}
              users={userOptions}
              disabled={isLoading}
              placeholder={isLoading ? "Loading users..." : "Select a user"}
              searchPlaceholder="Search users by name or email"
              className="min-w-0 flex-1"
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
              <span>View as user</span>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function RolesSettingsPage() {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner featureName="RBAC" />
      <DisabledEnterpriseSection disabled={!enterpriseCoreActive}>
        <RolesListEnterprise headerAction={<RoleDebuggerDialog />} />
      </DisabledEnterpriseSection>
    </ErrorBoundary>
  );
}
