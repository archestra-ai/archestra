import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import badgeRoutes from './badge';
import categoryRoutes from './category';
import searchRoutes from './search';
import serverRoutes from './server';

const apiV1Routes: FastifyPluginAsyncZod = async (fastify) => {
  await fastify.register(badgeRoutes);
  await fastify.register(categoryRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(serverRoutes);
};

export default apiV1Routes;
