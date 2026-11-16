/**
 * The text of an "Arguments (one per line)" field as the list of arguments:
 * each line is one argument, without the spaces around it; an empty line is
 * none.
 */
export function argumentsFromText(text: string | null | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);
}

/** A list of arguments as the text of the field: one line for each. */
export function argumentsToText(
  values: readonly string[] | null | undefined,
): string {
  return values?.join("\n") || "";
}
