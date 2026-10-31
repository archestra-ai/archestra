import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ContainerDeploymentFields } from "@/components/container-deployment-fields";
import { Field, FieldControl } from "./field";
import { Input } from "./input";

function DeploymentFields() {
  const [value, setValue] = useState({ image: "", command: "", arguments: "" });
  return (
    <ContainerDeploymentFields
      ids={{ image: "image", command: "command", arguments: "args" }}
      value={value}
      onChange={setValue}
      command={{ description: "The executable to start." }}
      errors={{ image: !value.image && "Enter a container image." }}
    />
  );
}

describe("shared fields", () => {
  it("exposes help and validation on the actual container controls, and clears the error after editing", () => {
    render(<DeploymentFields />);
    const image = screen.getByRole("textbox", { name: "Container image" });
    expect(image).toHaveAccessibleDescription("Enter a container image.");
    expect(image).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("textbox", { name: "Command" }),
    ).toHaveAccessibleDescription("The executable to start.");
    fireEvent.change(image, { target: { value: "example/agent:latest" } });
    expect(image).not.toHaveAttribute("aria-invalid", "true");
    expect(image).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText("Enter a container image."),
    ).not.toBeInTheDocument();
    const args = screen.getByRole("textbox", {
      name: "Arguments (one per line)",
    });
    fireEvent.change(args, { target: { value: "--mode\nreview" } });
    expect(args).toHaveValue("--mode\nreview");
  });

  it("preserves extra accessible help and includes only existing field descriptions", () => {
    render(
      <>
        <p id="external-help">Additional guidance.</p>
        <Field
          id="name"
          label="Name"
          description="Choose a name."
          error="Name is required."
        >
          <FieldControl aria-describedby="external-help">
            <Input />
          </FieldControl>
        </Field>
      </>,
    );
    expect(
      screen.getByRole("textbox", { name: "Name" }),
    ).toHaveAccessibleDescription(
      "Additional guidance. Choose a name. Name is required.",
    );
  });
});
