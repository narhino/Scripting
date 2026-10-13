import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import { buildMcpServer } from './mcp.js';
import { listQuery, packagingInput, scriptInput, scriptPatch, statusInput } from './schemas.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * One secret (APP_KEY) protects everything. Agents send it as a Bearer token or X-API-Key header,
 * the browser sends it as the password of a Basic-auth prompt, and MCP connectors that can't set
 * headers may pass it as ?key=. With no APP_KEY set the app is open (meant for local use only).
 */
function providedKey(req, { allowQuery }) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  if (req.get('x-api-key')) return req.get('x-api-key');
  if (allowQuery && typeof req.query.key === 'string') return req.query.key;
  return null;
}

export function createApp({ store, appKey = '', publicUrl = '' }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('query parser', 'simple');

  const baseUrlFor = (req) => (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  // Edits made from the dashboard are attributed to "you"; everything else to the calling agent.
  const actorFor = (req, fallback = 'agent') => (req.get('x-client') === 'dashboard' ? 'you' : req.get('x-agent-name') || fallback);
  const idParam = (req) => store.resolveId(req.params.id);

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (!appKey) return next();
    const key = providedKey(req, { allowQuery: req.path === '/mcp' });
    if (key !== null && safeEqual(key, appKey)) return next();
    if (!req.path.startsWith('/api/') && req.path !== '/mcp') {
      res.set('WWW-Authenticate', 'Basic realm="Script Desk", charset="UTF-8"');
    }
    res.status(401).json({ error: 'Missing or wrong key. Send "Authorization: Bearer <APP_KEY>".' });
  });

  app.use(express.json({ limit: '5mb' }));

  const api = express.Router();

  api.get('/meta', (req, res) => res.json(store.meta()));

  api.get('/scripts', (req, res) => {
    res.json({ scripts: store.listScripts(listQuery.parse(req.query)) });
  });

  api.post('/scripts', (req, res) => {
    const input = scriptInput.parse(req.body);
    const fromDashboard = req.get('x-client') === 'dashboard';
    const { script, created } = store.createScript(input, {
      actor: fromDashboard ? 'you' : input.source || req.get('x-agent-name') || '',
      seen: fromDashboard,
    });
    res.status(created ? 201 : 200).json({
      ...script,
      revised_existing: !created,
      url: `${baseUrlFor(req)}/#/script/${script.id}`,
    });
  });

  api.get('/scripts/:id', (req, res) => res.json(store.getScript(idParam(req))));

  api.patch('/scripts/:id', (req, res) => {
    res.json(store.updateScript(idParam(req), scriptPatch.parse(req.body), { actor: actorFor(req) }));
  });

  api.delete('/scripts/:id', (req, res) => {
    store.deleteScript(idParam(req));
    res.status(204).end();
  });

  api.post('/scripts/:id/status', (req, res) => {
    const { status, video_url } = statusInput.parse(req.body);
    res.json(store.setStatus(idParam(req), status, { video_url, actor: actorFor(req) }));
  });

  api.post('/scripts/:id/seen', (req, res) => {
    store.markSeen(idParam(req));
    res.status(204).end();
  });

  api.post('/seen', (req, res) => res.json({ marked: store.markAllSeen() }));

  const putPackaging = (req, res) => {
    res.json(store.upsertPackaging(idParam(req), packagingInput.parse(req.body), { actor: actorFor(req) }));
  };
  api.put('/scripts/:id/packaging', putPackaging);
  api.patch('/scripts/:id/packaging', putPackaging);

  // Server-sent events so open dashboards update the moment an agent uploads something.
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const send = (change) => res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    store.changes.on('change', send);
    req.on('close', () => {
      clearInterval(ping);
      store.changes.off('change', send);
    });
  });

  api.get('/agent-guide', (req, res) => {
    const base = baseUrlFor(req);
    res.json({
      base_url: base,
      key_required: Boolean(appKey),
      api_url: `${base}/api/scripts`,
      mcp_url: `${base}/mcp`,
      mcp_url_with_key: appKey ? `${base}/mcp?key=YOUR_APP_KEY` : `${base}/mcp`,
    });
  });

  app.use('/api', api);

  app.post('/mcp', async (req, res) => {
    const server = buildMcpServer(store, { baseUrl: baseUrlFor(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Invalid input',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body must be valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large (max 5 MB)' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return app;
}
