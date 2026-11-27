import {
  GIT_HOST_RATE_LIMITED_CODE,
  GIT_REPOSITORY_NOT_FOUND_CODE,
} from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";

/** A scan that could not read its repository, as the import queries report it. */
export interface RepositoryReadFailure {
  /** The API error's `internal_code`, when the cause is a known one. */
  code: string | null;
  message: string;
}

/**
 * Why an import could not read the repository that was entered, for the
 * skill and plugin import dialogs alike.
 *
 * The two causes a person can act on get words of their own: a repository
 * that was not found (mistyped, or private), and a host that has stopped
 * answering for its request limit, where the access is not the thing to
 * change. Anything else shows what the server said. The heading and the text
 * are two rows; side by side, the text wrapped in a narrow second column.
 */
export function RepositoryReadNotice({
  failure,
  isPublicAccess,
}: {
  failure: RepositoryReadFailure;
  /** The repository is read without a credential. */
  isPublicAccess: boolean;
}) {
  const notFound = failure.code === GIT_REPOSITORY_NOT_FOUND_CODE;
  const rateLimited = failure.code === GIT_HOST_RATE_LIMITED_CODE;
  const title = notFound
    ? "Couldn’t find the repository."
    : "Couldn’t read the repository.";
  const text = notFound
    ? isPublicAccess
      ? "Private? Change the access above."
      : "Check that the credential can read it."
    : rateLimited
      ? "The host’s request limit is used up. Try again later."
      : failure.message;
  return (
    <InlineNotice variant="error" className="items-start">
      <AlertTriangle className="mt-0.5" />
      <InlineNoticeBody>
        <span className="font-medium">{title}</span>
        <InlineNoticeText>{text}</InlineNoticeText>
      </InlineNoticeBody>
    </InlineNotice>
  );
}
