"use client";

import { E2eTestId } from "@shared";
import { Eye } from "lucide-react";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import config from "@/lib/config/config";
import {
  useCanImpersonate,
  useImpersonateUser,
  useImpersonationCandidates,
} from "@/lib/impersonation.query";

const { RolesList } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with roles
    await import("@/components/roles/roles-list.ee")
  : await import("@/components/roles/roles-list");

function RoleDebuggerCallout() {
  const canImpersonate = useCanImpersonate();
  const { data: candidates, isLoading } = useImpersonationCandidates();
  const { mutate: impersonate, isPending } = useImpersonateUser();
  const [selectedUserId, setSelectedUserId] = useState<string>("");

  if (!canImpersonate) return null;

  return (
    <div className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">Want to debug a role?</p>
      <p className="text-muted-foreground">
        Pick a user and view the app as them. The session expires after one hour
        or when you click <em>Return to admin</em> in the banner.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Select
          value={selectedUserId}
          onValueChange={setSelectedUserId}
          disabled={isLoading || !candidates || candidates.length === 0}
        >
          <SelectTrigger className="w-72">
            <SelectValue
              placeholder={
                isLoading
                  ? "Loading users…"
                  : !candidates || candidates.length === 0
                    ? "No users available"
                    : "Select a user"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(candidates ?? []).map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.role ? ` · ${candidate.role}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
    </div>
  );
}

export default function RolesSettingsPage() {
  return (
    <ErrorBoundary>
      <RoleDebuggerCallout />
      <RolesList />
    </ErrorBoundary>
  );
}
