import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { packagingShape, scriptShape, statusInput } from './schemas.js';
import { STATUSES, STATUS_LABELS } from './store.js';

const INSTRUCTIONS = `Script Desk is the inbox where finished video scripts go.
When you finish a script, call upload_script with the full narration text in "body".
Include packaging (title options, thumbnail text/concept, description) when you have it,
or add it later with attach_packaging. Use external_id if you might upload a revision later.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const summarize = (script, baseUrl) => ({
  id: script.id,
  title: script.title,
  status: script.status,
  status_label: STATUS_LABELS[script.status],
  channel: script.channel,
  word_count: script.word_count,
  has_packaging: Boolean(script.packaging),
  created_at: script.created_at,
  url: `${baseUrl}/#/script/${script.id}`,
});

const scriptRef = {
  script_id: z.number().int().positive().optional().describe('Numeric id returned by upload_script'),
  external_id: z.string().optional().describe('The external_id you uploaded the script with'),
};

function resolveRef(store, { script_id, external_id }) {
  if (script_id) return store.resolveId(script_id);
  if (external_id) return store.resolveId(`ext:${external_id}`);
  throw new Error('Provide script_id or external_id');
}

/** Builds a fresh MCP server bound to the store. One is created per HTTP request (stateless mode). */
export function buildMcpServer(store, { baseUrl }) {
  const server = new McpServer({ name: 'script-desk', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('upload_script', {
    title: 'Upload a finished script',
    description: 'Add a finished video script to the Script Desk to-do list. It shows up as NEW for the editor. '
      + 'Put only the narration text in body. Optionally include packaging (titles, thumbnail, description).',
    inputSchema: scriptShape,
  }, async (input) => {
    const { script, created } = store.createScript(input, { actor: input.source || 'agent (MCP)' });
    return json({ ...summarize(script, baseUrl), revised_existing: !created });
  });

  server.registerTool('attach_packaging', {
    title: 'Attach packaging to a script',
    description: 'Add or update the packaging (title options, chosen title, thumbnail text/concept/images, '
      + 'description, tags) of a script already in the desk. Fields you omit are left unchanged.',
    inputSchema: { ...scriptRef, ...packagingShape },
  }, async ({ script_id, external_id, ...packaging }) => {
    const id = resolveRef(store, { script_id, external_id });
    const script = store.upsertPackaging(id, packaging, { actor: 'agent (MCP)' });
    return json({ ...summarize(script, baseUrl), packaging: script.packaging });
  });

  server.registerTool('list_scripts', {
    title: 'List scripts',
    description: 'List scripts in the desk. Use it to avoid writing a duplicate of a topic that is already queued or published.',
    inputSchema: {
      view: z.enum(['todo', 'archive', 'all']).default('all').describe('todo = not yet published, archive = published'),
      channel: z.string().optional(),
      search: z.string().optional().describe('Text to search for in titles, scripts and notes'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true },
  }, async ({ view, channel, search, limit }) => {
    const scripts = store.listScripts({ view, channel, q: search, limit });
    return json(scripts.map((s) => ({ ...summarize(s, baseUrl), chosen_title: s.packaging?.chosen_title || '' })));
  });

  server.registerTool('get_script', {
    title: 'Get a script',
    description: 'Fetch one script with its full text, packaging and activity history.',
    inputSchema: scriptRef,
    annotations: { readOnlyHint: true },
  }, async (ref) => json(store.getScript(resolveRef(store, ref))));

  server.registerTool('set_status', {
    title: 'Change script status',
    description: `Move a script through the pipeline: ${STATUSES.map((s) => `"${s}" (${STATUS_LABELS[s]})`).join(' → ')}. `
      + 'Use "created" once the voiceover audio exists and "uploaded" once the video is published (this archives it).',
    inputSchema: {
      ...scriptRef,
      status: z.enum(STATUSES),
      video_url: statusInput.shape.video_url.describe('Link to the published video (for "uploaded")'),
    },
  }, async ({ status, video_url, ...ref }) => {
    const script = store.setStatus(resolveRef(store, ref), status, { video_url, actor: 'agent (MCP)' });
    return json(summarize(script, baseUrl));
  });

  return server;
}
