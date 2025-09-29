import Fastify from 'fastify';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
});

// Health check route
fastify.get('/', async function handler() {
  return 'hello world!';
});

// Run the server!
const start = async () => {
  try {
    await fastify.listen({ port: 9000, host: '0.0.0.0' });
    fastify.log.info('OpenAI Proxy Server started on port 9000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
