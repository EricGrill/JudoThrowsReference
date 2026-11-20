const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = fs.readFileSync(path.join(__dirname, '../deploy/activate.sh'), 'utf8');
const PREVIOUS = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

function deploymentHarness(t, scenario) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jiujitsu-deploy-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const base = path.join(temporary, 'reference');
  const config = path.join(temporary, 'proxy.conf');
  const bin = path.join(temporary, 'bin');
  const log = path.join(temporary, 'calls.log');
  const activeApp = path.join(temporary, 'active-app');
  const smokeMarker = path.join(temporary, 'first-smoke-completed');
  fs.mkdirSync(bin, { recursive: true });
  for (const release of [PREVIOUS, NEXT]) {
    const deployment = path.join(base, 'releases', release, 'deploy');
    fs.mkdirSync(deployment, { recursive: true });
    fs.writeFileSync(path.join(deployment, 'compose.yml'), '# Mocked compose configuration\n');
    fs.writeFileSync(path.join(deployment, '00-jiujitsutools-reference.conf'), 'new proxy configuration\n');
  }
  fs.writeFileSync(config, 'previous proxy configuration\n');
  fs.writeFileSync(path.join(base, 'current-release'), `${PREVIOUS}\n`);
  fs.writeFileSync(activeApp, `${PREVIOUS}\n`);
  fs.writeFileSync(log, '');

  const patched = SOURCE
    .replace('base=/opt/jiujitsu-reference', `base='${base}'`)
    .replace('config=/opt/bjjchat/nginx/conf.d/00-jiujitsutools-reference.conf', `config='${config}'`);
  assert.notEqual(patched, SOURCE, 'test copy must use temporary deployment paths');
  assert.ok(!patched.includes('/opt/'), 'no production paths may remain in the test copy');
  const script = path.join(temporary, 'activate.sh');
  fs.writeFileSync(script, patched);

  function executable(name, source) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${source}\n`, { mode: 0o755 });
  }
  executable('docker', `
printf '%s|%s|%s\\n' "$RELEASE" "$PWD" "$*" >> "$MOCK_LOG"
if [ "$1" = compose ] && [ "$4" = up ]; then
  if [ "$MOCK_SCENARIO" = replacement-failure ] && [ "$RELEASE" = "$MOCK_NEXT" ]; then
    printf '%s\\n' replacement-failed > "$MOCK_ACTIVE_APP"
    exit 1
  fi
  printf '%s\\n' "$RELEASE" > "$MOCK_ACTIVE_APP"
fi
exit 0`);
  executable('curl', `
printf '%s|%s|curl %s\\n' "$RELEASE" "$PWD" "$*" >> "$MOCK_LOG"
if [ "$MOCK_SCENARIO" = smoke-failure ]; then exit 22; fi
if [ "$MOCK_SCENARIO" = delayed-reload ] && [ ! -f "$MOCK_SMOKE_MARKER" ]; then
  touch "$MOCK_SMOKE_MARKER"
  printf '%s\\n' '<html><title>Legacy training tools</title></html>'
  exit 0
fi
printf '%s\\n' '<html><title>Jiu Jitsu Tools</title></html>'`);
  executable('sleep', 'exit 0');

  const cwd = path.join(base, 'releases', NEXT);
  return {
    base, config, log, activeApp,
    run() {
      return spawnSync('sh', [script, NEXT], {
        cwd,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOCK_LOG: log,
          MOCK_SCENARIO: scenario,
          MOCK_NEXT: NEXT,
          MOCK_ACTIVE_APP: activeApp,
          MOCK_SMOKE_MARKER: smokeMarker,
        },
        encoding: 'utf8', timeout: 5000,
      });
    },
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n'),
    backups: () => fs.readdirSync(path.join(base, 'backups')),
  };
}

test('failed container replacement restores the previous release without touching the proxy', (t) => {
  const app = deploymentHarness(t, 'replacement-failure');
  const result = app.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Container replacement failed/);
  assert.equal(fs.readFileSync(app.activeApp, 'utf8'), `${PREVIOUS}\n`);
  assert.equal(fs.readFileSync(path.join(app.base, 'current-release'), 'utf8'), `${PREVIOUS}\n`);
  assert.equal(fs.readFileSync(app.config, 'utf8'), 'previous proxy configuration\n');
  const calls = app.calls();
  assert.ok(calls.some((line) => line.startsWith(`${NEXT}|`) && line.endsWith('compose -f deploy/compose.yml up -d')));
  assert.ok(calls.some((line) => line.startsWith(`${PREVIOUS}|${app.base}/releases/${PREVIOUS}|`) && line.endsWith('compose -f deploy/compose.yml up -d')));
  assert.equal(calls.some((line) => line.includes('nginx')), false);
});

test('failed public smoke restores both the previous proxy and running app', (t) => {
  const app = deploymentHarness(t, 'smoke-failure');
  const result = app.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Public smoke test failed/);
  assert.equal(fs.readFileSync(app.config, 'utf8'), 'previous proxy configuration\n');
  assert.equal(fs.readFileSync(app.activeApp, 'utf8'), `${PREVIOUS}\n`);
  assert.equal(fs.readFileSync(path.join(app.base, 'current-release'), 'utf8'), `${PREVIOUS}\n`);
  const calls = app.calls();
  const smokeIndex = calls.findIndex((line) => line.includes('|curl '));
  const reloads = calls.map((line, index) => ({ line, index })).filter(({ line }) => line.endsWith('exec bjj-nginx nginx -s reload'));
  assert.equal(reloads.length, 2);
  assert.ok(reloads[0].index < smokeIndex);
  assert.ok(reloads[1].index > smokeIndex);
  assert.ok(calls.at(-1).startsWith(`${PREVIOUS}|${app.base}/releases/${PREVIOUS}|`));
});

test('repeated successful activation keeps separate immutable backup directories', (t) => {
  const app = deploymentHarness(t, 'success');
  const first = app.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(fs.readFileSync(path.join(app.base, 'current-release'), 'utf8'), `${NEXT}\n`);
  assert.equal(fs.readFileSync(app.activeApp, 'utf8'), `${NEXT}\n`);
  const firstBackups = app.backups();
  assert.equal(firstBackups.length, 1);
  const originalBackup = path.join(app.base, 'backups', firstBackups[0]);
  assert.equal(fs.readFileSync(path.join(originalBackup, 'previous.conf'), 'utf8'), 'previous proxy configuration\n');
  assert.equal(fs.readFileSync(path.join(originalBackup, 'previous-release'), 'utf8'), `${PREVIOUS}\n`);

  const second = app.run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const allBackups = app.backups();
  assert.equal(allBackups.length, 2);
  assert.equal(new Set(allBackups).size, 2);
  const newBackup = path.join(app.base, 'backups', allBackups.find((name) => name !== firstBackups[0]));
  assert.equal(fs.readFileSync(path.join(newBackup, 'previous.conf'), 'utf8'), 'new proxy configuration\n');
  assert.equal(fs.readFileSync(path.join(newBackup, 'previous-release'), 'utf8'), `${NEXT}\n`);
  assert.equal(fs.readFileSync(path.join(originalBackup, 'previous.conf'), 'utf8'), 'previous proxy configuration\n');
  assert.equal(fs.readFileSync(path.join(originalBackup, 'previous-release'), 'utf8'), `${PREVIOUS}\n`);
});


test('delayed nginx reload retries legacy content and publishes without rollback', (t) => {
  const app = deploymentHarness(t, 'delayed-reload');
  const result = app.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Published/);
  assert.equal(fs.readFileSync(app.config, 'utf8'), 'new proxy configuration\n');
  assert.equal(fs.readFileSync(app.activeApp, 'utf8'), `${NEXT}\n`);
  assert.equal(fs.readFileSync(path.join(app.base, 'current-release'), 'utf8'), `${NEXT}\n`);
  const calls = app.calls();
  assert.equal(calls.filter((line) => line.includes('|curl ')).length, 2);
  assert.equal(calls.filter((line) => line.endsWith('exec bjj-nginx nginx -s reload')).length, 1);
  assert.equal(calls.filter((line) => line.endsWith('compose -f deploy/compose.yml up -d')).length, 1);
  assert.equal(calls.some((line) => line.startsWith(`${PREVIOUS}|`)), false);
});
