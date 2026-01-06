import { useDebounce } from "@uidotdev/usehooks";
import { useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";

type DebouncedInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "onChange" | "value"
> & {
  initialValue: string;
  onChange: (value: string) => void;
  debounceMs?: number;
};

export function DebouncedInput({
  initialValue,
  onChange,
  debounceMs = 800,
  ...props
}: DebouncedInputProps) {
  const [value, setValue] = useState(initialValue);
  const isFirstRender = useRef(true);

  const debouncedValue = useDebounce(value, debounceMs);

  // Sync internal state when initialValue changes (e.g., browser back/forward)
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's ok here
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onChange(debouncedValue);
  }, [debouncedValue]);

  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      {...props}
    />
  );
}
