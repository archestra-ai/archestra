import { ExternalLink, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface AuthErrorToolProps {
  title: string;
  description: ReactNode;
  buttonText: string;
  buttonUrl: string;
  /** When provided, renders an inline button instead of an external link */
  onAction?: () => void;
}

export function AuthErrorTool({
  title,
  description,
  buttonText,
  buttonUrl,
  onAction,
}: AuthErrorToolProps) {
  return (
    <div className="mt-3 rounded-xl border border-border px-5 py-4">
      <div className="flex flex-wrap items-start gap-3 text-sm">
        <KeyRound className="mt-0.5 size-4 flex-none text-amber-600" />
        <div className="min-w-0 flex-1 text-muted-foreground">
          <span className="font-medium text-foreground">{title}:</span>{" "}
          <span>{description}</span>
        </div>
        {onAction ? (
          <Button variant="secondary" size="sm" onClick={onAction}>
            {buttonText}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" asChild>
            <a href={buttonUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-3.5" />
              {buttonText}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
