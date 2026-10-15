import { useQuery } from "@tanstack/react-query";
import { validationContentHash } from "./validation-run-history";

/** Each file's content hash, to match it against the hashes runs recorded. */
export function useValidationFileHashes(
  files: { path: string; content: string }[] | undefined,
) {
  return useQuery({
    queryKey: [
      "openappa-validation-file-hashes",
      files?.map((file) => [file.path, file.content]),
    ],
    enabled: files !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () =>
      Promise.all(
        (files ?? []).map(async (file) => ({
          path: file.path,
          contentHash: await validationContentHash(file.content),
        })),
      ),
  });
}
