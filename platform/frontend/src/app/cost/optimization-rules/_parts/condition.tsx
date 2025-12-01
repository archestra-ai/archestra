import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OptimizationRule } from "@/lib/optimization-rule.query";

type RuleType = OptimizationRule["ruleType"];
type Conditions = OptimizationRule["conditions"];
type ChangeHandler = (ruleType: RuleType, conditions: Conditions) => void;

function ConditionBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-row gap-2 whitespace-nowrap items-center rounded-md bg-secondary h-9 px-4">
      {children}
    </div>
  );
}
export function Condition({
  ruleType,
  conditions,
  onChange,
  editable,
}: {
  ruleType: RuleType;
  conditions: Conditions;
  onChange?: ChangeHandler;
  editable?: boolean;
}) {
  // Extract first condition for display (for now we display/edit only the first one)
  const firstCondition = conditions[0] || {};
  const maxLength =
    "maxLength" in firstCondition ? firstCondition.maxLength : 1000;
  const hasTools =
    "hasTools" in firstCondition ? firstCondition.hasTools : false;

  function onTypeChange(type: RuleType) {
    const newConditions: Conditions =
      type === "content_length" ? [{ maxLength }] : [{ hasTools }];
    onChange?.(type, newConditions);
  }

  function onMaxLengthChange(length: number) {
    const newConditions: Conditions = [{ maxLength: length }];
    onChange?.(ruleType, newConditions);
  }

  function onToolsChange(hasTools: boolean) {
    const newConditions: Conditions = [{ hasTools }];
    onChange?.(ruleType, newConditions);
  }

  let trigger = null;
  if (ruleType === "content_length") {
    trigger = (
      <span className="flex gap-2">
        content length
        <span>&lt;</span>
      </span>
    );
  } else if (ruleType === "tool_presence") {
    trigger = <>tool calls</>;
  }

  if (!editable) {
    if (ruleType === "content_length") {
      return (
        <ConditionBlock>
          content length <span>&lt;</span>
          <Badge variant="outline" className="text-sm bg-background">
            {maxLength}
          </Badge>
          tokens
        </ConditionBlock>
      );
    } else if (ruleType === "tool_presence") {
      return (
        <ConditionBlock>
          tool calls{" "}
          <Badge variant="outline" className="text-sm bg-background">
            {hasTools ? "present" : "absent"}
          </Badge>
        </ConditionBlock>
      );
    }
  }

  let controls = null;
  if (ruleType === "content_length") {
    controls = (
      <span className="flex gap-2 items-center">
        <Input
          type="number"
          name="maxTokens"
          value={maxLength}
          placeholder="count"
          className="px-2 h-7 w-20 bg-background"
          onChange={(e) => onMaxLengthChange(Number(e.target.value))}
          min="1"
          max="999999"
        />
        tokens
      </span>
    );
  } else if (ruleType === "tool_presence") {
    controls = (
      <Select
        value={hasTools ? "true" : "false"}
        onValueChange={(value) => onToolsChange(value === "true")}
      >
        <SelectTrigger size="sm" className="bg-background !h-7">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="false">absent</SelectItem>
          <SelectItem value="true">present</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <ConditionBlock>
      {onChange && editable ? (
        <DropdownMenu>
          <DropdownMenuTrigger className="h-7 px-2 ml-[-8px]">
            {trigger}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="ml-[-8px]">
            <DropdownMenuItem onClick={() => onTypeChange("content_length")}>
              content length in tokens
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTypeChange("tool_presence")}>
              with or without tool calls
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        trigger
      )}
      {controls}
    </ConditionBlock>
  );
}
