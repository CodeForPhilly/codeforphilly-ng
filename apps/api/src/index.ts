import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger:
    process.env.NODE_ENV === 'production'
      ? true
      : { transport: { target: 'pino-pretty' } },
});

app.get('/api/health', () => ({ status: 'ok' }));

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
