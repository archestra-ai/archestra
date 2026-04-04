import { CircleHelp, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatLinkButtonProps {
  label?: string | null | undefined;
  url: string | null | undefined;
}

export function ChatLinkButton({ label, url }: ChatLinkButtonProps) {
  if (!url) {
    return null;
  }

  return (
    <Button asChild variant="outline" size="sm" className="gap-2">
      <a href={url} target="_blank" rel="noopener noreferrer">
        <CircleHelp className="h-4 w-4" />
        {label?.trim() || "Open Link"}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </Button>
  );
}
