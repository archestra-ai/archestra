"use client";

import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Response } from "@/components/ai-elements/response";
import { SectionLabel } from "@/components/ai-elements/tool";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { SkillApprovalView } from "./skill-approval-presentation";

export function SkillApprovalInput({ skill }: { skill: SkillApprovalView }) {
  return (
    <div className="space-y-4 p-3">
      <SectionLabel accent="bg-sky-400">Skill</SectionLabel>
      <dl className="space-y-4">
        {skill.currentName ? (
          <SkillField label="Current name">
            <CodeText>{skill.currentName}</CodeText>
          </SkillField>
        ) : null}
        <SkillField label="Name">
          <CodeText>{skill.name}</CodeText>
        </SkillField>
        <SkillField label="Description">
          <p className="whitespace-pre-wrap">{skill.description}</p>
        </SkillField>
        <SkillField label="Instructions">
          <div className="rounded-md border border-border/60 bg-muted/20 p-3">
            {skill.instructions ? (
              <Response
                preserveLineBreaks
                className="[&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm"
              >
                {skill.instructions}
              </Response>
            ) : (
              <p className="text-muted-foreground">No instructions.</p>
            )}
          </div>
        </SkillField>
        {skill.metadata ? (
          <SkillField label="Additional metadata">
            <CodeBlock code={skill.metadata} language="json" wrapLongLines />
          </SkillField>
        ) : null}
        {skill.additionalArguments ? (
          <SkillField label="Additional arguments">
            <CodeBlock
              code={skill.additionalArguments}
              language="json"
              wrapLongLines
            />
          </SkillField>
        ) : null}
      </dl>
      <Collapsible className="group border-t border-border/60 pt-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="xs">
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            <span>Original request</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <CodeBlock
            code={skill.originalArguments}
            language="json"
            wrapLongLines
          >
            <CodeBlockCopyButton
              type="button"
              aria-label="Copy original request"
            />
          </CodeBlock>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SkillField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5 [overflow-wrap:anywhere]">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm leading-relaxed">{children}</dd>
    </div>
  );
}
