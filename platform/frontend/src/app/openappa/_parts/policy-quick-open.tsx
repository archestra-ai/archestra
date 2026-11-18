"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils/tailwind";
import {
  POLICY_FILE_KIND,
  POLICY_FILE_KINDS,
  PolicyStatusDot,
  policyFileIcon,
} from "./policy-file-kind";
import { VALIDATION_STATUS_LOOK } from "./policy-validation-pane";
import type { PolicyWorkspace } from "./use-policy-workspace";

/** A searchable palette of every policy file, grouped by kind. */
export function PolicyQuickOpen({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: PolicyWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const groups = POLICY_FILE_KINDS.map((kind) => ({
    kind,
    files: workspace.files.filter((file) => file.kind === kind),
  })).filter((group) => group.files.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Open a policy file</DialogTitle>
          <DialogDescription>
            Search the organization policy, batteries, included files and
            validations.
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Go to file" />
          <CommandList className="max-h-[min(60vh,440px)]">
            <CommandEmpty>No file matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.kind}
                heading={POLICY_FILE_KIND[group.kind].section}
              >
                {group.files.map((file) => {
                  const Icon = policyFileIcon(file);
                  return (
                    <CommandItem
                      key={file.key}
                      // The status is searchable: "needs" finds what to fix.
                      value={`${file.label} ${file.path} ${file.statusLabel ?? ""} ${file.validation?.title ?? ""} ${file.validation ? VALIDATION_STATUS_LOOK[file.validation.status].label : ""}`}
                      disabled={file.disabled}
                      onSelect={() => {
                        workspace.open(file.entry);
                        onOpenChange(false);
                      }}
                      className="h-7 gap-2 py-0 text-[13px]"
                    >
                      <Icon
                        className={cn(
                          "size-3.5",
                          POLICY_FILE_KIND[file.kind].iconClass,
                        )}
                        aria-hidden
                      />
                      <span className="shrink-0">
                        {file.kind === "repository"
                          ? file.name
                          : (file.validation?.title ?? file.label)}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                        {file.path}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        {file.mcpServerRules && <span>MCP server rules</span>}
                        {file.validation && (
                          <>
                            <span>
                              {
                                VALIDATION_STATUS_LOOK[file.validation.status]
                                  .label
                              }
                            </span>
                            <span
                              aria-hidden
                              className={cn(
                                "size-1.5 rounded-full",
                                VALIDATION_STATUS_LOOK[file.validation.status]
                                  .dot,
                              )}
                            />
                          </>
                        )}
                        {file.severity && (
                          <>
                            <span>{file.statusLabel}</span>
                            <PolicyStatusDot severity={file.severity} />
                          </>
                        )}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
