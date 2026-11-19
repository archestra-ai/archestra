import type { QuickOpenConfig } from "@/components/file-workspace/file-quick-open";
import { cn } from "@/lib/utils/tailwind";
import {
  POLICY_FILE_KIND,
  POLICY_FILE_KINDS,
  PolicyStatusDot,
  policyFileIcon,
} from "./policy-file-kind";
import { VALIDATION_STATUS_LOOK } from "./policy-validation-pane";
import type { PolicyWorkspace } from "./use-policy-workspace";

/** Every policy file for the workspace's palette, grouped by kind. */
export function policyQuickOpen(workspace: PolicyWorkspace): QuickOpenConfig {
  return {
    title: "Open a policy file",
    description:
      "Search the organization policy, batteries, included files and validations.",
    onSelect: (key) => {
      const file = workspace.files.find((candidate) => candidate.key === key);
      if (file) workspace.open(file.entry);
    },
    groups: POLICY_FILE_KINDS.map((kind) => ({
      heading: POLICY_FILE_KIND[kind].section,
      items: workspace.files
        .filter((file) => file.kind === kind)
        .map((file) => {
          const Icon = policyFileIcon(file);
          const validation = file.validation
            ? VALIDATION_STATUS_LOOK[file.validation.status]
            : null;
          return {
            key: file.key,
            // The status is searchable: "needs" finds what to fix.
            search: `${file.label} ${file.path} ${file.statusLabel ?? ""} ${file.validation?.title ?? ""} ${validation?.label ?? ""}`,
            disabled: file.disabled,
            icon: (
              <Icon
                className={cn(
                  "size-3.5",
                  POLICY_FILE_KIND[file.kind].iconClass,
                )}
                aria-hidden
              />
            ),
            label:
              file.kind === "repository"
                ? file.name
                : (file.validation?.title ?? file.label),
            detail: file.path,
            trailing:
              file.mcpServerRules || validation || file.severity ? (
                <>
                  {file.mcpServerRules && <span>MCP server rules</span>}
                  {validation && (
                    <>
                      <span>{validation.label}</span>
                      <span
                        aria-hidden
                        className={cn("size-1.5 rounded-full", validation.dot)}
                      />
                    </>
                  )}
                  {file.severity && (
                    <>
                      <span>{file.statusLabel}</span>
                      <PolicyStatusDot severity={file.severity} />
                    </>
                  )}
                </>
              ) : undefined,
          };
        }),
    })),
  };
}
