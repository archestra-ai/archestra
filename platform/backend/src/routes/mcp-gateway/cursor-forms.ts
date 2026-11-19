import { asRecord } from "@/utils/as-record";

/** Whether the request comes from Cursor's MCP client. */
export function isCursorClient(userAgent: unknown): boolean {
  return /^cursor\//i.test(String(userAgent ?? ""));
}

/**
 * The form as Cursor can show it. Cursor labels a checkbox with the field's
 * description and ignores its title, and without a description it shows the
 * field's key ("Enable option_0"). A text field's hint is its key too unless
 * it has a description. So each such field gets a description that carries
 * its title.
 */
export function cursorFormSchema(schema: unknown): unknown {
  const properties = asRecord(asRecord(schema)?.properties);
  if (!properties) return schema;
  return {
    ...(schema as object),
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const field = asRecord(value);
        const title = typeof field?.title === "string" ? field.title : "";
        if (!field || !title) return [key, value];
        const description =
          typeof field.description === "string" ? field.description : "";
        if (field.type === "boolean")
          return [
            key,
            {
              ...field,
              description: description ? `${title}: ${description}` : title,
            },
          ];
        if (field.type === "string" && !field.enum && !description)
          return [key, { ...field, description: title }];
        return [key, value];
      }),
    ),
  };
}
