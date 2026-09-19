import { Github } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getRepositoryDisplay } from "@/lib/github/repository-display";
import { cn } from "@/lib/utils";

export function RepositoryOwnerIcon({
  repo,
  className,
}: {
  repo: string;
  className?: string;
}) {
  const { owner, avatarUrl } = getRepositoryDisplay(repo);
  return (
    <Avatar className={cn("size-4 shrink-0", className)}>
      <AvatarImage
        src={avatarUrl ? `${avatarUrl}?size=32` : undefined}
        alt={`${owner} GitHub avatar`}
      />
      <AvatarFallback>
        <Github className="size-3" aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}
