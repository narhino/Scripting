import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sampleScript } from './helpers.js';

describe('REST API', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('rejects requests without the key, and prompts browsers for a password', async () => {
    const api = await srv.call('GET', '/api/scripts', { key: null });
    assert.equal(api.status, 401);
    assert.equal(api.headers.get('www-authenticate'), null);

    const page = await srv.call('GET', '/', { key: null });
    assert.equal(page.status, 401);
    assert.match(page.headers.get('www-authenticate'), /^Basic/);

    const wrong = await srv.call('GET', '/api/scripts', { key: 'nope' });
    assert.equal(wrong.status, 401);
  });

  test('accepts the key as Basic-auth password (browser) and X-API-Key', async () => {
    const basic = Buffer.from('anyone:test-key').toString('base64');
    const viaBasic = await srv.call('GET', '/api/meta', { key: null, headers: { Authorization: `Basic ${basic}` } });
    assert.equal(viaBasic.status, 200);
    const viaHeader = await srv.call('GET', '/api/meta', { key: null, headers: { 'X-API-Key': 'test-key' } });
    assert.equal(viaHeader.status, 200);
  });

  test('health check is public', async () => {
    const res = await srv.call('GET', '/healthz', { key: null });
    assert.equal(res.status, 200);
  });

  test('upload creates an unseen NEW script with word count and a dashboard link', async () => {
    const res = await srv.call('POST', '/api/scripts', { body: sampleScript() });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'new');
    assert.equal(res.body.seen, false);
    assert.equal(res.body.word_count, 13);
    assert.match(res.body.url, new RegExp(`/#/script/${res.body.id}$`));
    assert.equal(res.body.events[0].type, 'received');

    const meta = await srv.call('GET', '/api/meta');
    assert.ok(meta.body.counts.unseen >= 1);
    assert.ok(meta.body.channels.includes('History'));
  });

  test('scripts added from the dashboard are already seen', async () => {
    const res = await srv.call('POST', '/api/scripts', { body: sampleScript({ title: 'Typed by hand' }), headers: { 'X-Client': 'dashboard' } });
    assert.equal(res.body.seen, true);
  });

  test('validates input and reports which fields are wrong', async () => {
    const res = await srv.call('POST', '/api/scripts', {
      body: { title: '', body: 'x', packaging: { thumbnail_urls: ['javascript:alert(1)'] } },
    });
    assert.equal(res.status, 400);
    const paths = res.body.issues.map((i) => i.path);
    assert.ok(paths.includes('title'));
    assert.ok(paths.includes('packaging.thumbnail_urls.0'));
  });

  test('invalid JSON gets a clear 400', async () => {
    const res = await fetch(`${srv.base}/api/scripts`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);
  });

  test('full lifecycle: new -> audio created -> uploaded (archived) -> back', async () => {
    const { body: created } = await srv.call('POST', '/api/scripts', { body: sampleScript({ title: 'Lifecycle' }) });
    const id = created.id;
    const inView = async (view) => (await srv.call('GET', `/api/scripts?view=${view}`)).body.scripts.some((s) => s.id === id);

    assert.equal(await inView('todo'), true);
    assert.equal(await inView('archive'), false);

    const audio = await srv.call('POST', `/api/scripts/${id}/status`, { body: { status: 'created' } });
    assert.equal(audio.body.status, 'created');
    assert.ok(audio.body.audio_created_at);
    assert.equal(audio.body.seen, true, 'acting on a script marks it seen');

    const uploaded = await srv.call('POST', `/api/scripts/${id}/status`, {
      body: { status: 'uploaded', video_url: 'https://youtube.com/watch?v=xyz' },
    });
    assert.equal(uploaded.body.status, 'uploaded');
    assert.ok(uploaded.body.uploaded_at);
    assert.equal(uploaded.body.video_url, 'https://youtube.com/watch?v=xyz');
    assert.equal(await inView('todo'), false, 'uploaded scripts leave the to-do list');
    assert.equal(await inView('archive'), true, 'uploaded scripts go to the archive');

    const undone = await srv.call('POST', `/api/scripts/${id}/status`, { body: { status: 'created' } });
    assert.equal(undone.body.uploaded_at, null);
    assert.equal(undone.body.audio_created_at, audio.body.audio_created_at, 'keeps the original audio timestamp');
    assert.equal(await inView('todo'), true);

    const reset = await srv.call('POST', `/api/scripts/${id}/status`, { body: { status: 'new' } });
    assert.equal(reset.body.audio_created_at, null);

    const statusEvents = reset.body.events.filter((e) => e.type === 'status').map((e) => e.detail);
    assert.deepEqual(statusEvents, [
      'Audio created → New',
      'Uploaded → Audio created',
      'Audio created → Uploaded',
      'New → Audio created',
    ]);
  });

  test('rejects unknown statuses', async () => {
    const { body } = await srv.call('POST', '/api/scripts', { body: sampleScript() });
    const res = await srv.call('POST', `/api/scripts/${body.id}/status`, { body: { status: 'done' } });
    assert.equal(res.status, 400);
  });

  test('packaging can be attached later and merges field by field', async () => {
    const { body } = await srv.call('POST', '/api/scripts', { body: sampleScript() });
    assert.equal(body.packaging, null);

    const first = await srv.call('PUT', `/api/scripts/${body.id}/packaging`, {
      body: { titles: ['Option A', 'Option B'], thumbnail_text: 'ROME BURNS' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.packaging.chosen_title, 'Option A', 'defaults to the first title');

    const second = await srv.call('PUT', `/api/scripts/${body.id}/packaging`, {
      body: { chosen_title: 'Option C', description: 'All about Rome' },
    });
    assert.deepEqual(second.body.packaging.titles, ['Option C', 'Option A', 'Option B'], 'chosen title is added to the options');
    assert.equal(second.body.packaging.thumbnail_text, 'ROME BURNS', 'untouched fields are kept');
    assert.equal(second.body.packaging.description, 'All about Rome');
  });

  test('scripts can be addressed by external_id, and re-uploads revise instead of duplicating', async () => {
    const first = await srv.call('POST', '/api/scripts', { body: sampleScript({ external_id: 'rome-v1', title: 'Draft' }) });
    assert.equal(first.status, 201);
    await srv.call('POST', `/api/scripts/${first.body.id}/status`, { body: { status: 'created' } });

    const again = await srv.call('POST', '/api/scripts', { body: sampleScript({ external_id: 'rome-v1', title: 'Final', body: 'Shorter now.' }) });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.revised_existing, true);
    assert.equal(again.body.title, 'Final');
    assert.equal(again.body.word_count, 2);
    assert.equal(again.body.status, 'created', 'a revision keeps the workflow status');
    assert.equal(again.body.seen, false, 'a revision is flagged for you again');

    const pkg = await srv.call('PUT', '/api/scripts/ext:rome-v1/packaging', { body: { titles: ['By external id'] } });
    assert.equal(pkg.body.id, first.body.id);
  });

  test('search and channel filters', async () => {
    await srv.call('POST', '/api/scripts', { body: sampleScript({ title: 'Octopus minds', channel: 'Ocean', body: 'Nine brains and blue blood.' }) });
    const byText = await srv.call('GET', '/api/scripts?q=blue%20blood');
    assert.deepEqual(byText.body.scripts.map((s) => s.title), ['Octopus minds']);
    const byChannel = await srv.call('GET', '/api/scripts?channel=Ocean');
    assert.ok(byChannel.body.scripts.every((s) => s.channel === 'Ocean'));
    const wildcard = await srv.call('GET', '/api/scripts?q=%25');
    assert.equal(wildcard.body.scripts.length, 0, 'LIKE wildcards are matched literally');
  });

  test('mark seen, mark all seen, edit, delete', async () => {
    const { body } = await srv.call('POST', '/api/scripts', { body: sampleScript() });
    assert.equal((await srv.call('POST', `/api/scripts/${body.id}/seen`)).status, 204);
    assert.equal((await srv.call('GET', `/api/scripts/${body.id}`)).body.seen, true);

    await srv.call('POST', '/api/scripts', { body: sampleScript() });
    await srv.call('POST', '/api/seen');
    assert.equal((await srv.call('GET', '/api/meta')).body.counts.unseen, 0);

    const edited = await srv.call('PATCH', `/api/scripts/${body.id}`, { body: { title: 'Renamed', body: 'one two three' }, headers: { 'X-Client': 'dashboard' } });
    assert.equal(edited.body.title, 'Renamed');
    assert.equal(edited.body.word_count, 3);
    assert.equal(edited.body.events[0].actor, 'you');

    assert.equal((await srv.call('DELETE', `/api/scripts/${body.id}`)).status, 204);
    assert.equal((await srv.call('GET', `/api/scripts/${body.id}`)).status, 404);
  });

  test('live event stream announces new scripts', async () => {
    const controller = new AbortController();
    const res = await fetch(`${srv.base}/api/events`, { headers: { Authorization: 'Bearer test-key' }, signal: controller.signal });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    await srv.call('POST', '/api/scripts', { body: sampleScript({ title: 'Live one' }) });
    let text = '';
    while (!text.includes('Live one')) text += decoder.decode((await reader.read()).value);
    assert.match(text, /event: change\ndata: .*"type":"created".*"seen":false/);
    controller.abort();
  });
});

describe('without APP_KEY (local mode)', () => {
  let srv;
  before(async () => { srv = await startServer({ appKey: '' }); });
  after(async () => { await srv.close(); });

  test('everything is open', async () => {
    assert.equal((await srv.call('GET', '/api/meta', { key: null })).status, 200);
    assert.equal((await srv.call('GET', '/', { key: null })).status, 200);
  });
});
