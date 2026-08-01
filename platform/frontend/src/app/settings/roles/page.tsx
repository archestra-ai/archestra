"use client";

import { E2eTestId } from "@archestra/shared";
import { Eye } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DisabledEnterpriseSection } from "@/components/disabled-enterprise-section";
import { QueryLoadError } from "@/components/query-load-error";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
 * Compact popover entry point for the role debugger: a single small trigger
 * instead of the former full-width callout card, so the page leads with the
 * roles themselves. Candidates are only fetched once the popover opens.
 */
function RoleDebuggerPopover() {
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          data-testid={E2eTestId.ImpersonationDebugRoleButton}
        >
          <Eye className="mr-2 h-4 w-4" />
          <span>Debug a role</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">View the app as another user</p>
          <p className="text-xs text-muted-foreground">
            The impersonated session expires after one hour or when you click{" "}
            <em>Return to admin</em> in the banner.
          </p>
        </div>
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
              disabled={isLoading || !candidates || candidates.length === 0}
              placeholder={
                isLoading
                  ? "Loading users..."
                  : !candidates || candidates.length === 0
                    ? "No users available"
                    : "Select a user"
              }
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
      </PopoverContent>
    </Popover>
  );
}

export default function RolesSettingsPage() {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner featureName="RBAC" />
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          New users who join via email/password self-signup or ChatOps
          auto-provisioning are assigned a default role. Change it in{" "}
          <Link
            href="/settings/auth"
            className="font-medium underline underline-offset-4"
          >
            Settings → Auth
          </Link>
          .
        </p>
        <RoleDebuggerPopover />
      </div>
      <DisabledEnterpriseSection disabled={!enterpriseCoreActive}>
        <RolesListEnterprise />
      </DisabledEnterpriseSection>
    </ErrorBoundary>
  );
}
