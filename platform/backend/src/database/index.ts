import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import config from "@/config";
import * as schema from "./schemas";

const db = drizzle({
  connection: {
    connectionString: config.database.url,
  },
});

instrumentDrizzleClient(db, { dbSystem: "postgresql" });

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export default db;
export { schema };
