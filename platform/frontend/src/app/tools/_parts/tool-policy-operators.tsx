"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOperators } from "@/lib/policy.query";

interface ToolPolicyOperatorsProps {
  value: string;
  onChange: (value: string) => void;
}

export function ToolPolicyOperators({
  value,
  onChange,
}: ToolPolicyOperatorsProps) {
  const { data: operators = [] } = useOperators();

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Operator" />
      </SelectTrigger>
      <SelectContent>
        {operators.map((op) => (
          <SelectItem key={op.value} value={op.value}>
            {op.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
