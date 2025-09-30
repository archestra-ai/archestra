import path from 'node:path';
import { defineConfig } from 'prisma/config';

const DATABASE_DIRECTORY = 'src/database';

export default defineConfig({
  schema: path.join(DATABASE_DIRECTORY, 'schema.prisma'),
  migrations: {
    path: path.join(DATABASE_DIRECTORY, 'migrations'),
  },
  // views: {
  //   path: path.join('db', 'views'),
  // },
  // typedSql: {
  //   path: path.join('db', 'queries'),
  // },
});
