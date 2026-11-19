import { ApiError } from "@archestra/shared/types";

/** A translated request must never silently lose its output constraint. */
export function assertUnstructuredResponseFormat(
  request: { response_format?: { type: string } },
  target: string,
): void {
  if (request.response_format && request.response_format.type !== "text") {
    throw new ApiError(
      400,
      `Structured response_format is not supported by ${target}. Use the provider's native API for structured outputs.`,
    );
  }
}
