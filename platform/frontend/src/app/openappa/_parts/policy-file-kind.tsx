import {
  FileCode2,
  FlaskConical,
  Package,
  Server,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils/tailwind";
import type { PolicyFile } from "./policy-files";

/** How each kind of policy file is named and coloured wherever it is listed. */
export const POLICY_FILE_KIND = {
  root: {
    label: "Organization policy",
    section: "Organization policy",
    iconClass: "text-primary",
    chipClass: "border-primary/30 bg-primary/10 text-primary",
  },
  battery: {
    label: "Battery",
    section: "Batteries",
    iconClass: "text-violet-600 dark:text-violet-400",
    chipClass:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  repository: {
    label: "Included file",
    section: "Included files",
    iconClass: "text-sky-600 dark:text-sky-400",
    chipClass: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  validation: {
    label: "Validation",
    section: "Validations",
    iconClass: "text-teal-600 dark:text-teal-400",
    chipClass:
      "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
} as const;

export const POLICY_FILE_KINDS = [
  "root",
  "battery",
  "repository",
  "validation",
] as const;

/** What the "Included files" are, for whoever wonders. */
export const INCLUDED_FILES_HINT =
  "Other policy files in your connected repository that the organization policy pulls in with include, such as one rules file per MCP server.";

export function policyFileIcon(file: PolicyFile) {
  if (file.kind === "root") return ShieldCheck;
  if (file.kind === "battery") return Package;
  if (file.kind === "validation") return FlaskConical;
  return file.mcpServerRules ? Server : FileCode2;
}

/** A battery's status as a dot; the label beside it or in a tooltip names it. */
export function PolicyStatusDot({
  severity,
  className,
}: {
  severity: NonNullable<PolicyFile["severity"]>;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        severity === "ok"
          ? "bg-emerald-500"
          : severity === "warning"
            ? "bg-amber-500"
            : "bg-destructive",
        className,
      )}
    />
  );
}
