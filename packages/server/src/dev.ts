import { startDalangServer } from './app.js';

const { url, close } = await startDalangServer({
  port: Number(process.env.DALANG_PORT || 4173),
});

console.log(`DALANG server listening at ${url}`);

const shutdown = async () => {
  await close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
