import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFieldArray, useForm } from "react-hook-form";
import {
  formSchema,
  type McpCatalogFormValues,
} from "@/app/mcp/registry/_parts/mcp-catalog-form.types";
import { HeadersReadOnlyTable } from "@/components/headers-read-only-table";

describe("HeadersReadOnlyTable", () => {
  it("shows a header-name error that blocks form submission", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(<TestForm onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Header name contains invalid HTTP header characters",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

function TestForm({ onSubmit }: { onSubmit: () => void }) {
  const form = useForm<McpCatalogFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(formSchema as any),
    defaultValues: {
      name: "Remote MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "none",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [
        {
          headerName: "invalid header",
          promptOnInstallation: true,
          required: false,
          value: "",
          description: "",
        },
      ],
    },
  });
  const { fields, remove } = useFieldArray({
    control: form.control,
    name: "additionalHeaders",
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <HeadersReadOnlyTable
        form={form}
        fields={fields}
        fieldNamePrefix="additionalHeaders"
        onEdit={vi.fn()}
        onDelete={remove}
      />
      <button type="submit">Submit</button>
    </form>
  );
}
