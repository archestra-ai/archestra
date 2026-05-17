import { forwardRef, useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";

type DebouncedInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "onChange" | "value"
> & {
  initialValue: string;
  onChange: (value: string) => void;
  debounceMs?: number;
};

export const DebouncedInput = forwardRef<HTMLInputElement, DebouncedInputProps>(
  function DebouncedInput(
    { initialValue, onChange, debounceMs = 800, ...props }: DebouncedInputProps,
    ref,
  ) {
    const [value, setValue] = useState(initialValue);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isTypingRef = useRef(false);

    // Sync internal state when initialValue changes externally (e.g., browser back/forward)
    // but not while the user is actively typing to prevent eating characters
    useEffect(() => {
      if (!isTypingRef.current) {
        setValue(initialValue);
      }
    }, [initialValue]);

    useEffect(() => {
      return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      isTypingRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        onChange(newValue);
      }, debounceMs);
    };

    return <Input ref={ref} value={value} onChange={handleChange} {...props} />;
  },
);
DebouncedInput.displayName = "DebouncedInput";
