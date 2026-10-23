import { TriangleAlert } from "lucide-react";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import type { CoverageSummary } from "@/lib/openappa-coverage.query";
import { OpenAppaChatButton } from "./openappa-chat-button";

type Totals = CoverageSummary["totals"];

/**
 * Tools no specific rule judges, as a warning with a way into the chat to fix
 * it: tools with no rule first, else the wildcard fallback covering at least
 * half of the tools.
 */
export function CoverageWarnings({ totals }: { totals: Totals }) {
  const warning = coverageWarning(totals);
  if (!warning) return null;
  return (
    <div className="flex flex-col gap-2">
      <InlineNotice variant={warning.variant}>
        <TriangleAlert />
        <InlineNoticeBody>
          <span className="font-medium">{warning.title}</span>
          <InlineNoticeText>{warning.text}</InlineNoticeText>
        </InlineNoticeBody>
      </InlineNotice>
      <OpenAppaChatButton
        size="xs"
        variant="outline"
        className="self-end"
        promptKey="improveCoverage"
      >
        <span>Fix in chat</span>
      </OpenAppaChatButton>
    </div>
  );
}

function coverageWarning(totals: Totals) {
  if (totals.tools === 0) return null;
  if (totals.notCovered > 0)
    return {
      variant: "error" as const,
      title: "Unchecked tools.",
      text: `${toolCount(totals.notCovered)} ${totals.notCovered === 1 ? "has" : "have"} no rule and always ${totals.notCovered === 1 ? "runs" : "run"}. Create rules for limits on what each tool can do.`,
    };
  if (totals.catchAll * 2 >= totals.tools)
    return {
      variant: "warning" as const,
      title: "Few specific rules.",
      text: `${toolCount(totals.catchAll)} ${totals.catchAll === 1 ? "uses" : "use"} the wildcard fallback. Create specific rules for precise control over each tool.`,
    };
  return null;
}

const toolCount = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "tool" : "tools"}`;
