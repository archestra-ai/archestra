"use client";

import type { ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { CopyButton } from "@/components/copy-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/ai-elements/code-block";

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const serializedInput = JSON.stringify(input, null, 2);

  return (
    <Collapsible
      defaultOpen={false}
      className={cn("space-y-2 overflow-hidden p-4", className)}
      {...props}
    >
      <div className="space-y-2">
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 cursor-pointer">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Parameters
          </h4>
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in">
          <div className="rounded-md bg-muted/50 mt-2">
            <CodeBlock code={serializedInput} language="json">
              <CopyButton text={serializedInput} />
            </CodeBlock>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
