import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from './helpers.js';

async function connect(url, requestInit) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
  return client;
}

const parse = (result) => JSON.parse(result.content[0].text);

describe('MCP endpoint', () => {
  let srv;
  let client;
  before(async () => {
    srv = await startServer();
    client = await connect(`${srv.base}/mcp`, { headers: { Authorization: 'Bearer test-key' } });
  });
  after(async () => {
    await client.close();
    await srv.close();
  });

  test('lists the agent tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['attach_packaging', 'get_script', 'list_scripts', 'set_status', 'upload_script']);
  });

  test('an agent can upload a script, attach packaging and see it listed', async () => {
    const uploaded = parse(await client.callTool({
      name: 'upload_script',
      arguments: { title: 'Octopus minds', body: 'Nine brains, three hearts.', channel: 'Ocean', source: 'science-agent' },
    }));
    assert.equal(uploaded.status, 'new');
    assert.equal(uploaded.has_packaging, false);
    assert.match(uploaded.url, /#\/script\/\d+$/);

    const packaged = parse(await client.callTool({
      name: 'attach_packaging',
      arguments: { script_id: uploaded.id, titles: ['They Have NINE Brains'], thumbnail_text: '9 BRAINS' },
    }));
    assert.equal(packaged.packaging.chosen_title, 'They Have NINE Brains');

    const listed = parse(await client.callTool({ name: 'list_scripts', arguments: { search: 'octopus' } }));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].chosen_title, 'They Have NINE Brains');

    const full = parse(await client.callTool({ name: 'get_script', arguments: { script_id: uploaded.id } }));
    assert.equal(full.body, 'Nine brains, three hearts.');
    assert.equal(full.events.length, 2);
  });

  test('an agent can move a script along and address it by external_id', async () => {
    parse(await client.callTool({ name: 'upload_script', arguments: { title: 'Ext', body: 'Text', external_id: 'abc-1' } }));
    const moved = parse(await client.callTool({ name: 'set_status', arguments: { external_id: 'abc-1', status: 'created' } }));
    assert.equal(moved.status, 'created');
    assert.equal(moved.status_label, 'Audio created');
  });

  test('bad input comes back as a tool error, not a crash', async () => {
    const result = await client.callTool({ name: 'upload_script', arguments: { title: 'No body' } });
    assert.equal(result.isError, true);
    const missing = await client.callTool({ name: 'get_script', arguments: { script_id: 99999 } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not found/i);
  });

  test('connectors that cannot set headers may pass the key in the URL', async () => {
    const viaQuery = await connect(`${srv.base}/mcp?key=test-key`);
    assert.ok((await viaQuery.listTools()).tools.length > 0);
    await viaQuery.close();
  });

  test('wrong key is refused', async () => {
    await assert.rejects(connect(`${srv.base}/mcp?key=wrong`));
  });
});
