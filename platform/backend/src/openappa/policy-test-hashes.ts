import { createHash } from "node:crypto";
import type { PolicyTestFile } from "@/types/openappa-policy-tests";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const policyTestFilesHash = (files: readonly PolicyTestFile[]) =>
  hash(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))));

export function githubPolicyTestVersion(params: {
  repo: string | null;
  commit: string | null;
  directory: string;
  files: readonly PolicyTestFile[];
}) {
  return hash(
    JSON.stringify({
      repo: params.repo,
      commit: params.commit,
      directory: params.directory,
      filesHash: policyTestFilesHash(params.files),
    }),
  );
}
