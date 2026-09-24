import { ArrowRight, Bot } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { GuardrailsPolicyEditor } from "../guardrails-policy-editor";

export default async function OpenAppaPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ entry?: string; line?: string }>;
}) {
  const { entry, line } = await searchParams;
  const focusLine = Number(line);
  return (
    <div className="space-y-4">
      <InlineNotice variant="warning">
        <Bot />
        <span className="font-medium">Configure with the agent</span>
        <InlineNoticeText>
          Ask the OpenAPPA Configuration Agent to explain and propose policy
          changes.
        </InlineNoticeText>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <Link href="/openappa/configure?start=review">
            <span>Try now</span>
            <ArrowRight />
          </Link>
        </Button>
      </InlineNotice>
      <GuardrailsPolicyEditor
        readOnly
        sourceEntry={entry}
        focusLine={
          Number.isSafeInteger(focusLine) && focusLine > 0
            ? focusLine
            : undefined
        }
      />
    </div>
  );
}
