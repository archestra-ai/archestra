import { X } from "lucide-react";
import type React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

type Conditions = OptimizationRule["conditions"];
type Condition = Conditions[number];
type ChangeHandler = (condition: Condition) => void;

function ConditionBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-row gap-2 whitespace-nowrap items-center rounded-md bg-muted h-9 px-4">
      {children}
    </div>
  );
}
export function Condition({
  condition,
  editable,
  removable,
  onChange,
  onRemove,
}: {
  condition: Condition;
  onChange?: ChangeHandler;
  onRemove?: () => void;
  editable?: boolean;
  removable?: boolean;
}) {
  const maxLength = "maxLength" in condition ? condition.maxLength : 1000;
  const hasTools = "hasTools" in condition ? condition.hasTools : false;

  function onConditionChange(newCondition: Condition) {
    onChange?.(newCondition);
  }

  function onMaxLengthChange(length: number) {
    onChange?.({ maxLength: length });
  }

  function onToolsChange(hasTools: boolean) {
    onChange?.({ hasTools });
  }

  let trigger = null;
  if ("maxLength" in condition) {
    trigger = (
      <span className="flex gap-2">
        content length
        <span>&lt;</span>
      </span>
    );
  } else {
    trigger = <>tools</>;
  }

  if (!editable) {
    if ("maxLength" in condition) {
      return (
        <ConditionBlock>
          content length <span>&lt;</span>
          <Badge variant="outline" className="text-sm">
            {maxLength}
          </Badge>
          tokens
        </ConditionBlock>
      );
    } else {
      return (
        <ConditionBlock>
          tools{" "}
          <Badge variant="outline" className="text-sm">
            {hasTools ? "present" : "absent"}
          </Badge>
        </ConditionBlock>
      );
    }
  }

  let controls = null;
  if ("maxLength" in condition) {
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
  } else {
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
            <DropdownMenuItem
              onClick={() => onConditionChange({ maxLength: 1000 })}
            >
              content length in tokens
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onConditionChange({ hasTools: false })}
            >
              with or without tools
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        trigger
      )}
      {controls}
      {removable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-6 h-6 mr-[-6px] bg-primary/20"
          onClick={onRemove}
          title="Remove condition"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </ConditionBlock>
  );
}
