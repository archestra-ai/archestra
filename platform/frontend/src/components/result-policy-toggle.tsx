import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RESULT_POLICY_ACTION_OPTIONS,
  RESULT_POLICY_ACTION_OPTIONS_LONG,
  type ResultPolicyAction,
} from "@/lib/policy.utils";

interface ResultPolicyToggleProps {
  value: ResultPolicyAction;
  onChange: (action: ResultPolicyAction) => void;
  disabled?: boolean;
  size?: "sm" | "lg";
}

export function ResultPolicyToggle({
  value,
  onChange,
  disabled,
  size = "sm",
}: ResultPolicyToggleProps) {
  const isLarge = size === "lg";
  const options = isLarge
    ? RESULT_POLICY_ACTION_OPTIONS_LONG
    : RESULT_POLICY_ACTION_OPTIONS;

  return (
    <Select
      value={value}
      onValueChange={(val: ResultPolicyAction) => onChange(val)}
      disabled={disabled}
    >
      <SelectTrigger
        className={isLarge ? "w-[220px]" : "h-8 w-[150px] text-xs"}
        size={isLarge ? "default" : "sm"}
        // Stop propagation so the compact variant can live inside clickable rows
        // without triggering the row's onClick.
        onClick={isLarge ? undefined : (e) => e.stopPropagation()}
      >
        <SelectValue placeholder="Select action" />
      </SelectTrigger>
      <SelectContent>
        {options.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
