import { CircleHelp, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// The app shell's mobile-only header exposes this container so pages can
// portal actions into the header bar next to the sidebar trigger.
export const MOBILE_HEADER_ACTIONS_CONTAINER_ID = "mobile-header-actions";

interface ChatLinkButtonProps {
  label?: string | null | undefined;
  url: string | null | undefined;
  className?: string;
}

export function ChatLinkButton({ label, url, className }: ChatLinkButtonProps) {
  if (!url) {
    return null;
  }

  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className={cn("gap-2", className)}
    >
      <a href={url} target="_blank" rel="noopener noreferrer">
        <CircleHelp className="h-4 w-4" />
        {label?.trim() || "Open Link"}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </Button>
  );
}

// Chat links rendered into the app shell's mobile header bar (hidden on
// desktop, where the splash shows the full buttons instead). A single link
// renders as the regular button; multiple links collapse into one help icon
// that opens a menu, since the header bar has no room for several buttons.
export function MobileHeaderChatLinks({
  links,
}: {
  links: ChatLinkButtonProps[];
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setContainer(document.getElementById(MOBILE_HEADER_ACTIONS_CONTAINER_ID));
  }, []);

  const validLinks = links.filter((link) => !!link.url);
  if (!container || validLinks.length === 0) {
    return null;
  }

  if (validLinks.length === 1) {
    return createPortal(
      <ChatLinkButton label={validLinks[0].label} url={validLinks[0].url} />,
      container,
    );
  }

  return createPortal(
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="Help and support">
          <CircleHelp className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {validLinks.map((link) => (
          <DropdownMenuItem key={`link-${link.label}-${link.url}`} asChild>
            <a
              href={link.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <CircleHelp className="h-4 w-4" />
              {link.label?.trim() || "Open Link"}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>,
    container,
  );
}
