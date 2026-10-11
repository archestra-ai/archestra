import { describeAgentOwner } from "@/lib/agent-owner-label";
import { cn } from "@/lib/utils/tailwind";

type PersonalResource = {
  scope: "personal" | "team" | "org";
  authorId: string | null;
  authorEmail?: string | null;
};

export function PersonalResourceOwner({
  resource,
  currentUserId,
  className,
}: {
  resource: PersonalResource;
  currentUserId: string | null | undefined;
  className?: string;
}) {
  const owner = describeAgentOwner(
    {
      scope: resource.scope,
      ownerId: resource.authorId,
      ownerEmail: resource.authorEmail ?? null,
    },
    currentUserId,
  );

  if (owner.kind === "scope") return null;

  const label =
    owner.kind === "self"
      ? "Yours"
      : owner.kind === "user"
        ? `Owned by ${owner.email}`
        : "Owner unavailable";

  return (
    <span className={cn("block text-xs text-muted-foreground", className)}>
      {label}
    </span>
  );
}
