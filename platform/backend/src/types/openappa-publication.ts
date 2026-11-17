import { ApiError } from "@archestra/shared/types";

/**
 * Where a keyed change request was sent: the Git source's repository and the
 * credential that reaches it, which also names its host.
 */
export type PublicationTarget = { repo: string; credentialId: string };

/**
 * A pull or merge request create that was sent and not confirmed: no answer,
 * a server fault or an unreadable success, and no request found from its
 * branch afterwards. It may still have opened, so `findPublicationByKey`,
 * given this `target`, decides the outcome later; a caller neither reopens the
 * change nor publishes it again under a new key.
 */
export class PublicationUncertainError extends ApiError {
  constructor(
    readonly operationKey: string,
    readonly target: PublicationTarget,
  ) {
    super(
      502,
      "The Git host did not confirm the change request, so it may have opened. Check the publication before trying again.",
    );
    this.name = "PublicationUncertainError";
  }
}
