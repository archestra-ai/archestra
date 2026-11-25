import {
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { PackageSearch } from "lucide-react";

import { SettingIcon } from "@/components/setting-icon";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface AgentSubagentLoadingSettingProps {
  /**
   * Whether the assigned subagents stay out of the tool list and are reached
   * through the search/run dispatch pair.
   */
  progressive: boolean;
  onProgressiveChange: (progressive: boolean) => void;
  readOnly: boolean;
  /** What the section calls a delegation target: a gateway's are "agents". */
  noun: "subagent" | "agent";
}

/**
 * How Manual subagents are shown to the model. It mirrors the tools section's
 * "Progressive tool loading" row; "All agents" has no such choice, because a
 * set with no bound is always loaded this way.
 */
export function AgentSubagentLoadingSetting({
  progressive,
  onProgressiveChange,
  readOnly,
  noun,
}: AgentSubagentLoadingSettingProps) {
  return (
    <div className="flex items-center gap-3">
      <SettingIcon tone={progressive ? "on" : "off"}>
        <PackageSearch className="size-4" />
      </SettingIcon>
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor="load-subagents-when-needed">
          {`Progressive ${noun} loading`}
        </Label>
        <FieldDescription>
          {/* Distinct keys: with the same tag React would reconcile the two
              branches in place and delete the text a page translator moved. */}
          {progressive ? (
            <span key="progressive">
              <span>{`Saves context by keeping the ${noun}s out of the tool list. They are found with `}</span>
              <code>{TOOL_SEARCH_TOOLS_SHORT_NAME}</code>
              <span> and run with </span>
              <code>{TOOL_RUN_TOOL_SHORT_NAME}</code>
              <span>.</span>
            </span>
          ) : (
            <span key="listed">
              {`Every assigned ${noun} is a tool in the model's context from the first message.`}
            </span>
          )}
        </FieldDescription>
      </div>
      <Switch
        id="load-subagents-when-needed"
        checked={progressive}
        disabled={readOnly}
        onCheckedChange={onProgressiveChange}
      />
    </div>
  );
}
