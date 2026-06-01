import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentToSkillConversion } from "@/lib/agent.query";

type ConvertToSkillReportDialogProps = {
  result: AgentToSkillConversion | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Shows the outcome of an agent→skill conversion: which fields carried over
 * cleanly versus which were folded into the SKILL.md body or metadata. The
 * conversion is lossy (a skill has no tools/model/knowledge of its own), so the
 * report makes that explicit instead of hiding it.
 */
export function ConvertToSkillReportDialog({
  result,
  onOpenChange,
}: ConvertToSkillReportDialogProps) {
  return (
    <Dialog open={result !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Converted to skill</DialogTitle>
          <DialogDescription>
            {result
              ? `Created the skill "${result.skill.name}". The agent is unchanged.`
              : null}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <DialogBody className="space-y-4">
            <ReportSection
              title="Carried over"
              fields={result.report.carried}
            />
            <ReportSection
              title="Annotated into the skill body or metadata"
              fields={result.report.annotated}
              hint="A skill carries instructions only — tools, model, and knowledge bindings are noted under a Requirements section to re-attach later."
            />
          </DialogBody>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button asChild>
            <Link href="/agents/skills">View skills</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportSection({
  title,
  fields,
  hint,
}: {
  title: string;
  fields: { field: string; detail: string }[];
  hint?: string;
}) {
  if (fields.length === 0) return null;
  return (
    <div>
      <h4 className="font-medium text-sm">{title}</h4>
      {hint ? (
        <p className="mt-1 text-muted-foreground text-xs">{hint}</p>
      ) : null}
      <ul className="mt-2 space-y-1">
        {fields.map((field) => (
          <li key={field.field} className="text-sm">
            <span className="font-medium">{field.field}</span>
            <span className="text-muted-foreground"> — {field.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
