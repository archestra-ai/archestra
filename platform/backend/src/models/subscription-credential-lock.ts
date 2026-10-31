import { sql } from "drizzle-orm";
import db, { type Transaction } from "@/database";

export function withSubscriptionCredentialLock<Result>(params: {
  provider: string;
  providerApiKeyId: string;
  run: (transaction: Transaction) => Promise<Result>;
}): Promise<Result> {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${params.provider}-subscription:${params.providerApiKeyId}`}, 0))`,
    );
    return params.run(transaction);
  });
}
