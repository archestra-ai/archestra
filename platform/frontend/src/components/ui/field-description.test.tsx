import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { FieldDescription } from "./field-description";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "./form";
import { Input } from "./input";

function FieldUnderTest() {
  const form = useForm({ defaultValues: { email: "" } });

  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="email"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Email</FormLabel>
            <FormDescription>Where we send the invite.</FormDescription>
            <FormControl>
              <Input {...field} />
            </FormControl>
          </FormItem>
        )}
      />
    </Form>
  );
}

describe("FormDescription", () => {
  it("keeps the control described by the description that now precedes it", () => {
    render(<FieldUnderTest />);

    const description = screen.getByText("Where we send the invite.");
    const describedBy = screen
      .getByRole("textbox")
      .getAttribute("aria-describedby");

    expect(describedBy?.split(" ")).toContain(description.id);
  });

  it("takes its styling from the shared FieldDescription", () => {
    // The point of the refactor: descriptions are styled in exactly one place,
    // so re-hardcoding the classes in form.tsx must fail here.
    render(
      <>
        <FieldUnderTest />
        <FieldDescription>Standalone</FieldDescription>
      </>,
    );

    expect(screen.getByText("Where we send the invite.").className).toBe(
      screen.getByText("Standalone").className,
    );
  });
});
