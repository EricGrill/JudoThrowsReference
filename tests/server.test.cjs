const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

async function startServer(upstream) {
  let server;
  const fakeHttp = {
    createServer(handler) {
      server = http.createServer(handler);
      const listen = server.listen.bind(server);
      server.listen = () => listen(0, '127.0.0.1');
      return server;
    },
  };
  const context = {
    require: (name) => name === 'http' ? fakeHttp : require(name),
    __dirname: ROOT, process: { argv: [], env: {} },
    URL, AbortSignal, AbortController, setTimeout, clearTimeout,
    console: { log() {} }, fetch: upstream,
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), context);
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

const sampleVideo = { videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'Throw demonstration' }] }, ownerText: { runs: [{ text: 'A coach' }] } } };

 test('catalog contains 68 unique complete throws', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/throws.js'), 'utf8');
  const { THROWS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(THROWS.length, 68);
  assert.equal(new Set(THROWS.map((item) => item.id)).size, 68);
  for (const item of THROWS) {
    for (const field of ['id', 'name', 'en', 'kanji', 'set', 'type', 'desc']) assert.ok(item[field], field);
    assert.ok(item.tips.length);
  }
});

test('public assets and video API preserve their response contract', async (t) => {
  const app = await startServer(async () => ({ ok: true, text: async () => `var ytInitialData = ${JSON.stringify({ contents: [sampleVideo, sampleVideo] })};` }));
  t.after(app.close);
  const home = await fetch(app.base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="throw-select"/);
  const script = await fetch(`${app.base}/src/main.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${app.base}/api/search`)).status, 400);
  const response = await fetch(`${app.base}/api/search?q=seoi+nage`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { videos: [{ id: 'abcdefghijk', title: 'Throw demonstration', channel: 'A coach' }] });
});

test('server refuses private paths, malformed URLs, and write methods', async (t) => {
  const app = await startServer(() => { throw new Error('unexpected upstream request'); });
  t.after(app.close);
  for (const route of ['/.git/config', '/server.js', '/package.json', '/.env', '/src/../server.js']) {
    assert.equal((await fetch(app.base + route)).status, 404, route);
  }
  assert.equal((await fetch(`${app.base}/%ZZ`)).status, 400);
  assert.equal((await fetch(app.base, { method: 'POST' })).status, 405);
  const head = await fetch(app.base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const route of ['/favicon.svg', '/robots.txt', '/sitemap.xml']) assert.equal((await fetch(app.base + route)).status, 200);
});

test('video API validates input and caches successful results', async (t) => {
  let calls = 0;
  const app = await startServer(async () => {
    calls++;
    return { ok: true, text: async () => `var ytInitialData = ${JSON.stringify(sampleVideo)};` };
  });
  t.after(app.close);
  assert.equal((await fetch(`${app.base}/api/search?q=${'a'.repeat(201)}`)).status, 400);
  assert.equal(calls, 0);
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${app.base}/api/search?q=seoi+nage`)).status, 200);
  assert.equal(calls, 1);
});

test('upstream failure returns a controlled fallback response', async (t) => {
  let calls = 0;
  const app = await startServer(async () => { calls++; throw new Error('offline'); });
  t.after(app.close);
  const response = await fetch(`${app.base}/api/search?q=seoi`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /YouTube link/);
  assert.equal(calls, 1);
});
