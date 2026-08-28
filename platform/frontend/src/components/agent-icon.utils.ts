/** Values the shared Agent icon controls render as images rather than emoji. */
export function isAgentImageIcon(
  icon: string | null | undefined,
): icon is string {
  return (
    icon?.startsWith("data:image/") === true || icon?.startsWith("/") === true
  );
}
