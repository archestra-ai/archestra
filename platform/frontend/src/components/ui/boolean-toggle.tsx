import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";

interface BooleanToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  trueLabel?: string;
  falseLabel?: string;
  size?: "sm" | "default" | "lg" | "icon";
  variant?: "default" | "secondary";
}

export function BooleanToggle({
  value,
  onChange,
  disabled = false,
  trueLabel = "True",
  falseLabel = "False",
  size = "sm",
  variant = "default",
}: BooleanToggleProps) {
  return (
    <ButtonGroup>
      <Button
        type="button"
        size={size}
        variant={value ? variant : "outline"}
        onClick={() => onChange(true)}
        disabled={disabled}
      >
        {trueLabel}
      </Button>
      <Button
        type="button"
        size={size}
        variant={!value ? variant : "outline"}
        onClick={() => onChange(false)}
        disabled={disabled}
      >
        {falseLabel}
      </Button>
    </ButtonGroup>
  );
}
