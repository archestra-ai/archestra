import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Info } from "lucide-react";
import { useRef } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";

/**
 * The (i) next to the Pools column header and the Pooled switch: what a pool
 * does, with a link to the docs. The same hint in the table and the dialog,
 * so nobody opens a form to read it.
 */
export function PooledHint() {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        // Radix closes the hint when its trigger loses focus. When focus moves
        // onto the Learn more link inside the hint (a click on the link after
        // the icon itself was clicked), the hint has to stay: a prevented blur
        // skips Radix's own close.
        onBlur={(event) => {
          if (
            contentRef.current?.contains(event.relatedTarget as Node | null)
          ) {
            event.preventDefault();
          }
        }}
      >
        <UnstyledButton
          aria-label="About pooled tiers"
          className="text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      {/* Anchored at the icon, so the text stays inside its column or dialog. */}
      <TooltipContent ref={contentRef} align="start" className="max-w-xs">
        Agent runs start much quicker from pool of runtime instances. Managed
        automatically. Pooled instances reserve part of cluster's capacity.{" "}
        <ExternalDocsLink
          href={getDocsUrl(DocsPage.PlatformAgentRuntimeSetup, "warm-pools")}
        >
          Learn more
        </ExternalDocsLink>
      </TooltipContent>
    </Tooltip>
  );
}
