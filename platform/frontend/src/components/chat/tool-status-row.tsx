import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type ToolStatusRowAction =
  | {
      label: string;
      onClick: () => void;
      variant?: "secondary" | "outline" | "default";
      icon?: ReactNode;
    }
  | {
      label: string;
      href: string;
      variant?: "secondary" | "outline" | "default";
      icon?: ReactNode;
    };

interface ToolStatusRowProps {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  actions?: ToolStatusRowAction[];
  tone?: "default" | "destructive";
}

export function ToolStatusRow({
  icon,
  title,
  description,
  actions = [],
  tone = "default",
}: ToolStatusRowProps) {
  return (
    <div className="p-4 pt-0">
      <div className="flex flex-wrap items-start gap-3 text-sm">
        <div
          className={tone === "destructive" ? "text-destructive" : undefined}
        >
          {icon}
        </div>
        <div
          className={`min-w-0 flex-1 ${
            tone === "destructive"
              ? "text-destructive"
              : "text-muted-foreground"
          }`}
        >
          <span
            className={
              tone === "destructive"
                ? "font-medium"
                : "font-medium text-foreground"
            }
          >
            {title}:
          </span>{" "}
          <span>{description}</span>
        </div>
        {actions.length > 0 ? (
          <div className="ml-1 flex items-center gap-2">
            {actions.map((action) =>
              "href" in action ? (
                <Button
                  key={`${action.label}-${action.href}`}
                  variant={action.variant ?? "secondary"}
                  size="sm"
                  asChild
                >
                  <a
                    href={action.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {action.icon}
                    {action.label}
                  </a>
                </Button>
              ) : (
                <Button
                  key={action.label}
                  variant={action.variant ?? "secondary"}
                  size="sm"
                  onClick={action.onClick}
                >
                  {action.icon}
                  {action.label}
                </Button>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
