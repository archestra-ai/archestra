import logger from "@/logging";
import { marketplaceMaterializer } from "@/skills/marketplace";

/**
 * Best-effort cleanup of a revoked share link's materialized repo. Failures
 * must not surface to the user: revocation already took effect in the DB.
 * Call it once the revoking transaction has committed.
 */
export function dropRevokedSkillShareLinkRepo(id: string): void {
  void marketplaceMaterializer
    .get()
    .revoke({ kind: "link", id })
    .catch((err: unknown) => {
      logger.warn(
        { err, shareLinkId: id },
        "skill-share: failed to drop materialized repo after revoke",
      );
    });
}
