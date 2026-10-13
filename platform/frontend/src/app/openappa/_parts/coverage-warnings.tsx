import { TriangleAlert } from "lucide-react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { CoverageSummary } from "@/lib/openappa-coverage.query";
import { OpenAppaChatButton } from "./openappa-chat-button";

/** Tools no rule restricts, as a warning with a way into the chat to fix it. */
export function CoverageWarnings({
  totals,
}: {
  totals: CoverageSummary["totals"];
}) {
  if (totals.tools === 0 || totals.notCovered === 0) return null;
  return (
    <InlineNotice>
      <TriangleAlert />
      <span className="font-medium">Low coverage.</span>
      <InlineNoticeText>
        {`${totals.notCovered.toLocaleString()} ${totals.notCovered === 1 ? "tool always runs" : "tools always run"}, with any data.`}
      </InlineNoticeText>
      <OpenAppaChatButton
        size="xs"
        variant="outline"
        className="ml-auto"
        promptKey="improveCoverage"
      >
        <span>Fix in chat</span>
      </OpenAppaChatButton>
    </InlineNotice>
  );
}
