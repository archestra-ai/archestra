"use client";

import {
  AppWindow,
  ArrowRight,
  Bot,
  Globe,
  Network,
  Puzzle,
  Server,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { RemoteUserSelect } from "@/components/remote-user-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/auth/auth.query";
import {
  type Member,
  type MemberOwnedResources,
  useMemberOwnedResources,
  useRemoveMember,
} from "@/lib/member.query";
import { useMemberOptionsReferences } from "@/lib/member-options.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Confirms removing a member. Everything they share with others moves to a
 * new owner the admin picks (themselves by default); what only they could see
 * is deleted with them.
 */
export function RemoveUserDialog({
  member,
  onOpenChange,
}: {
  member: Member;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user.id ?? "";
  const owned = useMemberOwnedResources(member.userId);
  const removeMember = useRemoveMember();
  const memberName = member.name || member.email;
  const shared = owned.data?.shared ?? [];
  const personal = owned.data?.personal ?? [];
  const hasShared = shared.length > 0;
  const personalTotal = personal.reduce((sum, p) => sum + p.count, 0);

  // Start on the organization's configured new owner, unless that is the
  // person being removed; else on you.
  const { data: organization } = useOrganization();
  const configuredOwnerId = organization?.departingMemberOwnerId;
  const defaultOwnerId =
    configuredOwnerId && configuredOwnerId !== member.userId
      ? configuredOwnerId
      : currentUserId;
  const [pickedOwnerId, setNewOwnerId] = useState<string | null>(null);
  const newOwnerId = pickedOwnerId ?? defaultOwnerId;

  const ownerLookup = useMemberOptionsReferences({
    ids: newOwnerId && newOwnerId !== currentUserId ? [newOwnerId] : [],
  });
  const pickedRow = ownerLookup.data?.find((row) => row.id === newOwnerId);
  const ownerName = !newOwnerId
    ? "the new owner"
    : newOwnerId === currentUserId
      ? "you"
      : pickedRow?.name || pickedRow?.email || "the new owner";
  const pickedMember = newOwnerId === member.userId;
  const canConfirm =
    !removeMember.isPending &&
    !owned.isPending &&
    (!hasShared || (!!newOwnerId && !pickedMember));

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={`Remove ${memberName}`}
      description={
        hasShared
          ? `${memberName} leaves the organization. Pick who looks after what they share with others.`
          : `${memberName} leaves the organization and loses access to everything in it.`
      }
      size={hasShared ? "medium" : "small"}
    >
      <DialogBody className="space-y-5">
        {hasShared && (
          <div className="space-y-2">
            <Label>New owner</Label>
            <RemoteUserSelect
              source="members"
              value={newOwnerId}
              onValueChange={setNewOwnerId}
              placeholder="Choose a member"
              ariaLabel="New owner"
              className="w-full"
              excludeIds={[member.userId]}
              pinnedOption={
                session
                  ? {
                      value: currentUserId,
                      label: `You (${session.user.name})`,
                    }
                  : undefined
              }
            />
            {pickedMember ? (
              <p className="text-destructive text-xs">
                <span>Choose someone other than {memberName}.</span>
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                <span>
                  The new owner can edit and manage each item. People who use
                  them today keep their access.
                </span>
              </p>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-md border">
          {hasShared && (
            <section className="min-w-0">
              <LedgerHeader
                icon={<ArrowRight className="size-4" />}
                title={
                  <span key={ownerName}>
                    Moves to{" "}
                    <span className="text-foreground">{ownerName}</span>
                  </span>
                }
                count={shared.length}
              />
              <div className="max-h-72 overflow-y-auto">
                {groupByKind(shared).map(([kind, items]) => (
                  <div key={kind} className="border-b last:border-b-0">
                    <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5 font-medium text-muted-foreground text-xs">
                      <KindIcon kind={kind} />
                      <span>
                        {items.length === 1
                          ? KIND_LABELS[kind].one
                          : KIND_LABELS[kind].many}
                      </span>
                      <span className="ml-auto tabular-nums">
                        {items.length}
                      </span>
                    </div>
                    <ul>
                      {items.map((item) => (
                        <li
                          key={item.id}
                          className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {item.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                            <Users className="size-3" />
                            <span>{describeSharedWith(item.sharedWith)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          {personalTotal > 0 && (
            <section
              className={cn(
                "min-w-0 bg-destructive/[0.03]",
                hasShared && "border-t",
              )}
            >
              <LedgerHeader
                icon={<Trash2 className="size-4" />}
                title={<span>Deleted</span>}
                count={personalTotal}
                destructive
              />
              <ul className="space-y-1 px-3 py-2">
                {personal.map((p) => (
                  <li
                    key={p.kind}
                    className="flex items-center gap-2 py-1 text-sm"
                  >
                    <KindIcon kind={p.kind} />
                    <span className="flex-1">
                      {p.count === 1
                        ? KIND_LABELS[p.kind].one
                        : KIND_LABELS[p.kind].many}
                    </span>
                    <span className="font-medium text-destructive tabular-nums">
                      {p.count}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="px-3 pb-3 text-muted-foreground text-xs">
                <span>
                  Only {memberName} could see these, so they go away with their
                  account.
                </span>
              </p>
            </section>
          )}

          {!hasShared && personalTotal === 0 && (
            <p className="px-3 py-3 text-muted-foreground text-sm">
              <span>
                {owned.isPending
                  ? "Checking what they own…"
                  : owned.isError
                    ? "We couldn't check what they own. Anything they shared with others will move to you."
                    : `${memberName} doesn't own anything in the organization.`}
              </span>
            </p>
          )}
        </div>
      </DialogBody>
      <DialogStickyFooter className="mt-0">
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!canConfirm}
          onClick={async () => {
            await removeMember.mutateAsync({
              memberId: member.id,
              newOwnerId: hasShared ? newOwnerId : undefined,
            });
            onOpenChange(false);
          }}
        >
          {removeMember.isPending ? "Removing..." : "Remove user"}
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

// ===================================================================
// Internal helpers
// ===================================================================

type OwnedKind = MemberOwnedResources["personal"][number]["kind"];
type SharedItem = MemberOwnedResources["shared"][number];

function LedgerHeader({
  icon,
  title,
  count,
  destructive,
}: {
  icon: ReactNode;
  title: ReactNode;
  count: number;
  destructive?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-2.5 font-semibold text-sm",
        destructive ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <Badge
        variant="outline"
        className={cn(
          "tabular-nums",
          destructive && "border-destructive/40 text-destructive",
        )}
      >
        {count}
      </Badge>
    </div>
  );
}

function KindIcon({ kind }: { kind: OwnedKind }) {
  const Icon = KIND_ICONS[kind];
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function groupByKind(items: SharedItem[]): [OwnedKind, SharedItem[]][] {
  const groups = new Map<OwnedKind, SharedItem[]>();
  for (const item of items) {
    const list = groups.get(item.kind) ?? [];
    list.push(item);
    groups.set(item.kind, list);
  }
  return [...groups.entries()];
}

function describeSharedWith(sharedWith: SharedItem["sharedWith"]): string {
  if (sharedWith.organization) return "Everyone";
  const parts = [...sharedWith.teams];
  if (sharedWith.people > 0)
    parts.push(
      `${sharedWith.people} ${sharedWith.people === 1 ? "person" : "people"}`,
    );
  return parts.length > 0 ? parts.join(", ") : "Others";
}

const KIND_LABELS: Record<OwnedKind, { one: string; many: string }> = {
  agent: { one: "Agent", many: "Agents" },
  mcpGateway: { one: "MCP gateway", many: "MCP gateways" },
  skill: { one: "Skill", many: "Skills" },
  plugin: { one: "Plugin", many: "Plugins" },
  catalog: { one: "MCP server", many: "MCP servers" },
  app: { one: "App", many: "Apps" },
  remoteAgent: { one: "Remote agent", many: "Remote agents" },
};

const KIND_ICONS: Record<OwnedKind, typeof Bot> = {
  agent: Bot,
  mcpGateway: Network,
  skill: Sparkles,
  plugin: Puzzle,
  catalog: Server,
  app: AppWindow,
  remoteAgent: Globe,
};
