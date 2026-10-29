import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

describe("Select", () => {
  it("keeps a controlled value that loads after mount inside a form", async () => {
    const onValueChange = vi.fn();
    render(<SavedValueForm onValueChange={onValueChange} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent(
        "Okta (https://okta.example)",
      ),
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

// A form whose saved value arrives in an effect after the first render, the
// way edit forms seed their fields from a fetched record.
function SavedValueForm({
  onValueChange,
}: {
  onValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState<string | undefined>(undefined);
  useEffect(() => {
    setValue("idp-1");
  }, []);
  return (
    <form>
      <Select
        value={value ?? "none"}
        onValueChange={(next) => {
          onValueChange(next);
          setValue(next);
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="No Identity Provider selected" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No Identity Provider</SelectItem>
          <SelectItem value="idp-1">Okta (https://okta.example)</SelectItem>
        </SelectContent>
      </Select>
    </form>
  );
}
