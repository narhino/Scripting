import { createApp } from '../src/app.js';
import { openStore } from '../src/store.js';

/** Starts the app on a random port with an in-memory database. */
export async function startServer({ appKey = 'test-key' } = {}) {
  const store = openStore(':memory:');
  const app = createApp({ store, appKey });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, key = appKey, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(key && { Authorization: `Bearer ${key}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const isJson = res.headers.get('content-type')?.includes('json');
    return { status: res.status, headers: res.headers, body: text && isJson ? JSON.parse(text) : text || null };
  }

  return {
    base,
    store,
    call,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

export const sampleScript = (overrides = {}) => ({
  title: 'Why Rome Fell',
  body: 'Rome did not fall in a day. It took centuries of slow decline.',
  channel: 'History',
  source: 'history-writer',
  ...overrides,
});
