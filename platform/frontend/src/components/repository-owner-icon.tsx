import { Github } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function RepositoryOwnerIcon({
  repo,
  className,
}: {
  repo: string;
  className?: string;
}) {
  const owner = repo
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .split("/")[0];
  return (
    <Avatar className={cn("size-4 shrink-0", className)}>
      <AvatarImage
        src={`https://github.com/${owner}.png?size=32`}
        alt={`${owner} GitHub avatar`}
      />
      <AvatarFallback>
        <Github className="size-3" aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}
