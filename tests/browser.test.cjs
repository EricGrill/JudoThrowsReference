const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function appHarness({ fetcher = async () => { throw new Error('offline'); }, storage } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: '', innerHTML: '', hidden: true, className: '', textContent: '', disabled: false, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } });
    return elements.get(selector);
  };
  const values = new Map();
  const localStorage = storage || { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const THROWS = [{ id: 'seoi', name: 'Seoi-nage', en: 'Shoulder throw', kanji: '背負投', set: 'Set 1', type: 'Hand', desc: 'Description', tips: ['Tip'] }];
  const context = { THROWS, SETS: ['Set 1'], document: { querySelector: element }, localStorage, Map, Number, AbortController, setTimeout, clearTimeout, fetch: fetcher };
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8').replace(/^import .*;\n/, '').split('// ---------- wiring ----------')[0];
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.app = { renderDetail, searchVideos, findVideos, readSaved, getIndex: () => currentIndex };', context);
  return { app: context.app, element, values };
}

test('blocked browser storage does not break rendering or session notes', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const { app, element } = appHarness({ storage });
  app.renderDetail();
  element('#note-box').value = 'Practice the entry';
  element('#note-box').listeners.input();
  assert.equal(app.readSaved('gokyo.note.seoi'), 'Practice the entry');
  assert.match(element('#note-state').textContent, /until this page closes/);
  assert.match(element('#detail').innerHTML, /label for="note-box"/);
});

test('notes persist immediately and malformed saved indexes recover', () => {
  const values = new Map([['gokyo.index', '0.5']]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const { app, element } = appHarness({ storage });
  assert.equal(app.getIndex(), 0);
  app.renderDetail();
  element('#note-box').value = 'Grip reminder';
  element('#note-box').listeners.input();
  assert.equal(values.get('gokyo.note.seoi'), 'Grip reminder');
  element('#note-box').value = '';
  element('#note-box').listeners.input();
  assert.equal(values.has('gokyo.note.seoi'), false);
});

test('video search immediately exposes the direct link and makes one bounded request', async () => {
  let finish;
  let calls = 0;
  const { app, element } = appHarness({ fetcher: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  element('#context').value = 'for BJJ';
  const pending = app.findVideos();
  assert.equal(element('#yt-fallback').hidden, false);
  assert.match(element('#yt-fallback').innerHTML, /Seoi-nage%20judo%20for%20BJJ/);
  finish({ ok: false });
  await pending;
  assert.equal(calls, 1);
  assert.equal(element('#find-btn').disabled, false);
  assert.match(element('#video-status').textContent, /Couldn't load/);
});

test('video results reject unsafe IDs and normalize optional channel text', async () => {
  const { app } = appHarness({ fetcher: async () => ({ ok: true, json: async () => ({ videos: [{ id: '" onclick="', title: 'Unsafe' }, { id: 'abcdefghijk', title: 'Valid', channel: {} }] }) }) });
  const result = await app.searchVideos('seoi');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'abcdefghijk');
  assert.equal(result[0].channel, '');
});

test('new search cancels an obsolete browser request', async () => {
  const signals = [];
  const { app } = appHarness({ fetcher: async (_url, options) => { signals.push(options.signal); return { ok: false }; } });
  await app.searchVideos('first');
  await app.searchVideos('second');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});


test('quota failures keep the latest session note instead of returning an old saved value', () => {
  const storage = { getItem: () => 'Old saved note', setItem() { throw new Error('quota exceeded'); }, removeItem() { throw new Error('quota exceeded'); } };
  const { app, element } = appHarness({ storage });
  app.renderDetail();
  element('#note-box').value = 'Updated session note';
  element('#note-box').listeners.input();
  assert.equal(app.readSaved('gokyo.note.seoi'), 'Updated session note');
});
