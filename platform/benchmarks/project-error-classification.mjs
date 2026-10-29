const validationCodes = new Set([
  "path_not_allowed",
  "write_path_not_allowed",
  "replacement_must_match_exactly_once",
  "file_size_limit",
  "verified_complete_work_required",
  "already_published",
  "current_revision_receipt_required",
  "current_stage_source_required",
  "baseline_check_required",
  "read_or_edit_revision_required",
  "independent_final_check_required",
  "pure_source_required",
]);

export function projectToolError(error) {
  const code = String(error.message ?? "").split("\n")[0];
  return validationCodes.has(code)
    ? { kind: "request_validation", code }
    : {
        kind: "harness",
        code:
          code === "checker_process_failed" ? code : "invalid_project_request",
      };
}

// Call only for authenticated results from this benchmark's owned project tools.
export function projectResultError(result) {
  if (result?.isError !== true) return null;
  const declared = result._meta?.benchmark_error;
  if (declared?.kind === "harness") return "harness";
  if (
    declared?.kind === "request_validation" &&
    validationCodes.has(declared.code)
  )
    return "request_validation";
  for (const item of result.content ?? []) {
    if (
      item.type === "text" &&
      item.text?.startsWith("Project tool refused: ") &&
      validationCodes.has(item.text.slice("Project tool refused: ".length))
    )
      return "request_validation";
  }
  return "harness";
}
