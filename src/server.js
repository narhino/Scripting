import { createApp } from './app.js';
import { openStore } from './store.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const dbFile = process.env.DB_FILE || 'data/script-desk.db';
const appKey = process.env.APP_KEY || '';

const store = openStore(dbFile);
const app = createApp({ store, appKey, publicUrl: process.env.PUBLIC_URL || '' });

const server = app.listen(port, host, () => {
  console.log(`Script Desk running on http://localhost:${port}  (database: ${dbFile})`);
  if (!appKey) console.warn('APP_KEY is not set: anyone who can reach this port can read and change scripts. Set APP_KEY before exposing it.');
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Open SSE connections keep the server alive; don't wait for them.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
