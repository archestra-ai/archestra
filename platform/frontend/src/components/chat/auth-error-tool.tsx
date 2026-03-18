import { ExternalLink, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { ToolStatusRow } from "./tool-status-row";

interface AuthErrorToolProps {
  toolName: string;
  title: string;
  description: ReactNode;
  buttonText: string;
  buttonUrl: string;
  /** When provided, renders an inline button instead of an external link */
  onAction?: () => void;
}

export function AuthErrorTool({
  toolName,
  title,
  description,
  buttonText,
  buttonUrl,
  onAction,
}: AuthErrorToolProps) {
  return (
    <Tool defaultOpen={true}>
      <ToolHeader
        type={`tool-${toolName}`}
        state="output-error"
        isCollapsible={true}
      />
      <ToolContent>
        <ToolStatusRow
          icon={<KeyRound className="mt-0.5 size-4 flex-none text-amber-600" />}
          title={title}
          description={description}
          actions={[
            onAction
              ? {
                  label: buttonText,
                  onClick: onAction,
                  variant: "secondary",
                }
              : {
                  label: buttonText,
                  href: buttonUrl,
                  variant: "secondary",
                  icon: <ExternalLink className="size-3.5" />,
                },
          ]}
        />
      </ToolContent>
    </Tool>
  );
}
