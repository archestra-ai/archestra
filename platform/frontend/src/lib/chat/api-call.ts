import { handleApiError } from "@/lib/utils";

/**
 * The fields of an SDK call result this helper reads. `response` is undefined on
 * fetch exceptions (network/abort), so status access must be guarded.
 */
type ApiCallResult<T> = {
  data: T | undefined;
  error: unknown;
  response?: { status: number };
};

type CallApiOptions = {
  /** Status codes whose error is swallowed silently (no toast). */
  silentStatuses?: readonly number[];
  /** Skip handleApiError entirely (e.g. silent file fetch). */
  silent?: boolean;
};

/**
 * Run an SDK call, report the error via handleApiError (subject to options),
 * and return the success data unchanged or the fallback on error.
 */
export async function callApi<T, F>(
  call: () => Promise<ApiCallResult<T>>,
  fallback: F,
  options?: CallApiOptions,
): Promise<T | F> {
  const { data, error, response } = await call();
  if (!error) {
    return data as T;
  }
  const status = response?.status;
  const silentByStatus =
    status !== undefined &&
    (options?.silentStatuses?.includes(status) ?? false);
  if (!options?.silent && !silentByStatus) {
    handleApiError(error);
  }
  return fallback;
}
