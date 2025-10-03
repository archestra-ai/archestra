import { useDebounce } from "@uidotdev/usehooks";
import { useEffect, useState } from "react";
import { Input } from "./ui/input";

export function DebouncedInput({
  initialValue,
  onChange,
}: {
  initialValue: string;
  onChange: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  const debouncedValue = useDebounce(value, 800);

  // biome-ignore lint/correctness/useExhaustiveDependencies: it's ok here
  useEffect(() => {
    onChange(debouncedValue);
  }, [debouncedValue]);

  return (
    <Input defaultValue={value} onChange={(e) => setValue(e.target.value)} />
  );
}
