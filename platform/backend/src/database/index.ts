import { drizzle } from "drizzle-orm/node-postgres";
import config from "../config";
import * as schema from "./schema";

const db = drizzle({
  connection: {
    connectionString: config.database.url,
  },
});

export default db;
export * from "./schema";
export { schema };
