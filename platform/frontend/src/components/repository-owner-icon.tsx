import { DEFAULT_GIT_WEB_URLS, type GitProvider } from "@archestra/shared";
import { Github } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getRepositoryDisplay } from "@/lib/github/repository-display";
import { cn } from "@/lib/utils/tailwind";

export function RepositoryOwnerIcon({
  repo,
  className,
  provider,
}: {
  repo: string;
  className?: string;
  /** Defaults to GitLab for a gitlab.com URL, GitHub otherwise. */
  provider?: GitProvider | null;
}) {
  const { owner, avatarUrl } = getRepositoryDisplay(repo);
  const host =
    provider ??
    (repo.startsWith(`${DEFAULT_GIT_WEB_URLS.gitlab}/`) ? "gitlab" : "github");
  return (
    <Avatar className={cn("size-4 shrink-0", className)}>
      <AvatarImage
        src={avatarUrl ? `${avatarUrl}?size=32` : undefined}
        alt={`${owner} avatar`}
      />
      <AvatarFallback>
        {host === "gitlab" ? (
          <AgentIcon icon="logo:gitlab" size={12} />
        ) : (
          <Github className="size-3" aria-hidden />
        )}
      </AvatarFallback>
    </Avatar>
  );
}
