import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('src/prisma', 'schema.prisma'),
  migrations: {
    path: path.join('src/prisma', 'migrations'),
  },
  // views: {
  //   path: path.join('db', 'views'),
  // },
  // typedSql: {
  //   path: path.join('db', 'queries'),
  // },
});
