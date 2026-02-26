"use client";

import { Trash2, UserPlus } from "lucide-react";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type PendingSignupMember,
  useActiveOrganization,
  useDeletePendingSignupMember,
} from "@/lib/organization.query";

const PROVIDER_ICONS: Record<string, { src: string; alt: string }> = {
  slack: { src: "/icons/slack.png", alt: "Slack" },
  "ms-teams": { src: "/icons/ms-teams.png", alt: "Microsoft Teams" },
};

/**
 * Shows auto-provisioned members who haven't completed signup yet.
 * These are users created via Slack/Teams bot interaction who haven't
 * set up their password or signed in via SSO.
 */
export function PendingSignupMembers({
  pendingSignupMembers,
}: {
  pendingSignupMembers: PendingSignupMember[];
}) {
  const { data: activeOrg } = useActiveOrganization();
  const deleteMutation = useDeletePendingSignupMember();

  if (!pendingSignupMembers.length) return null;

  const members = activeOrg?.members;
  if (!members?.length) return null;

  const pendingUserIdSet = new Set(pendingSignupMembers.map((m) => m.userId));
  const providerByUserId = new Map(
    pendingSignupMembers
      .filter((m) => m.provider)
      .map((m) => [m.userId, m.provider!]),
  );

  const pendingMembers = members.filter((m) => pendingUserIdSet.has(m.userId));

  if (pendingMembers.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4" />
          Pending Account Setup
        </CardTitle>
        <CardDescription>
          Members auto-provisioned from Slack or Microsoft Teams who
          haven&apos;t completed their account setup yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {pendingMembers.map((member) => {
            const provider = providerByUserId.get(member.userId);
            const icon = provider ? PROVIDER_ICONS[provider] : null;

            return (
              <div
                key={member.id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  {icon && (
                    <Image
                      src={icon.src}
                      alt={icon.alt}
                      width={16}
                      height={16}
                      className="shrink-0"
                    />
                  )}
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">
                      {member.user.name || "Unknown"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {member.user.email}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">Pending signup</Badge>
                  <PermissionButton
                    permissions={{ member: ["delete"] }}
                    tooltip="Remove pending member"
                    size="icon"
                    variant="ghost"
                    onClick={() => deleteMutation.mutate(member.userId)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </PermissionButton>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
