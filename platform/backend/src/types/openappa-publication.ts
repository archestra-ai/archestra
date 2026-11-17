import { ApiError } from "@archestra/shared/types";

/**
 * A pull or merge request create that was sent and not confirmed: no answer,
 * or a server fault, and no request found from its branch afterwards. It may
 * still have opened, so `findPublicationByKey` decides the outcome later; a
 * caller neither reopens the change nor publishes it again under a new key.
 */
export class PublicationUncertainError extends ApiError {
  constructor(readonly operationKey: string) {
    super(
      502,
      "The Git host did not confirm the change request, so it may have opened. Check the publication before trying again.",
    );
    this.name = "PublicationUncertainError";
  }
}
