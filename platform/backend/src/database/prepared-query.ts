import { getDb } from "@/database";

/**
 * Compile a hot query once per database/transaction, never cache its results.
 * Weak keys preserve transaction affinity and let replaced test databases and
 * finished transactions be collected. Constructing this holder does no I/O.
 */
export class PreparedQuery<T> {
  private readonly queries = new WeakMap<ReturnType<typeof getDb>, T>();

  constructor(
    private readonly build: (database: ReturnType<typeof getDb>) => T,
  ) {}

  get(): T {
    const database = getDb();
    let query = this.queries.get(database);
    if (!query) {
      query = this.build(database);
      this.queries.set(database, query);
    }
    return query;
  }
}
