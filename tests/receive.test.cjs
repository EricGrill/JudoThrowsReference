const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../deploy/receive.sh'), 'utf8');

function harness(t, activationStatus = 0) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-receiver-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const base = path.join(temporary, 'reference');
  const origin = path.join(temporary, 'origin');
  const bin = path.join(temporary, 'bin');
  const calls = path.join(temporary, 'activated');
  fs.mkdirSync(base);
  fs.mkdirSync(origin);
  fs.mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  function git(args, cwd = origin) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Receiver Test']);
  fs.mkdirSync(path.join(origin, 'deploy'));
  fs.writeFileSync(path.join(origin, 'deploy/activate.sh'),
    `#!/bin/sh\nprintf '%s\\n' "$1" "$PWD" >> '${calls}'\nexit ${activationStatus}\n`);
  git(['add', '.']);
  git(['commit', '-m', 'Create test release']);
  const previous = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(origin, 'release.txt'), 'new release\n');
  git(['add', '.']);
  git(['commit', '-m', 'Advance main']);
  const current = git(['rev-parse', 'HEAD']);
  git(['clone', '--bare', origin, path.join(base, 'repository.git')]);
  // macOS lacks flock. Test command ordering and lock failure with this substitute.
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit "${MOCK_LOCK_STATUS:-0}"\n', { mode: 0o755 });
  const script = path.join(temporary, 'receive.sh');
  fs.writeFileSync(script, source.replace('base=/opt/jiujitsu-reference', `base='${base}'`));
  return {
    base, calls, current, previous, bin, git,
    run(command, extraEnv = {}) {
      return spawnSync('sh', [script], {
        env: { ...env, SSH_ORIGINAL_COMMAND: command, ...extraEnv },
        encoding: 'utf8', timeout: 5000,
      });
    },
  };
}

test('receiver rejects malformed SSH commands before any deployment', (t) => {
  const app = harness(t);
  for (const command of ['', 'a'.repeat(39), 'A'.repeat(40), `${app.current}; id`, `${app.current}\n`]) {
    const result = app.run(command);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /Expected/);
  }
  assert.equal(fs.existsSync(app.calls), false);
  assert.equal(fs.existsSync(path.join(app.base, 'deploy.lock')), false);
});

test('receiver rejects a stale commit after fetching current main', (t) => {
  const app = harness(t);
  const result = app.run(app.previous);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no longer main/);
  assert.equal(fs.existsSync(app.calls), false);
});

test('receiver extracts and activates only current main and reuses its release', (t) => {
  const app = harness(t);
  const result = app.run(app.current);
  assert.equal(result.status, 0, result.stderr);
  const releaseDir = path.join(app.base, 'releases', app.current);
  assert.equal(fs.readFileSync(path.join(releaseDir, 'release.txt'), 'utf8'), 'new release\n');
  assert.equal(fs.readFileSync(app.calls, 'utf8'), `${app.current}\n${releaseDir}\n`);
  const before = fs.statSync(path.join(releaseDir, 'release.txt')).ino;
  assert.equal(app.run(app.current).status, 0);
  assert.equal(fs.statSync(path.join(releaseDir, 'release.txt')).ino, before);
  assert.deepEqual(fs.readdirSync(path.join(app.base, 'releases')), [app.current]);
});

test('receiver propagates activation failure', (t) => {
  const app = harness(t, 17);
  const result = app.run(app.current);
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(app.base, 'releases')), [app.current]);
});

test('receiver does not activate after lock or fetch failure', (t) => {
  const app = harness(t);
  assert.equal(app.run(app.current, { MOCK_LOCK_STATUS: '1' }).status, 1);
  app.git(['--git-dir=' + path.join(app.base, 'repository.git'), 'remote', 'set-url', 'origin', '/nonexistent-reference-origin']);
  assert.notEqual(app.run(app.current).status, 0);
  assert.equal(fs.existsSync(app.calls), false);
});

test('receiver cleans partial extraction and never activates it', (t) => {
  const app = harness(t);
  fs.writeFileSync(path.join(app.bin, 'tar'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
  const result = app.run(app.current);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(fs.existsSync(app.calls), false);
  assert.deepEqual(fs.readdirSync(path.join(app.base, 'releases')), []);
});
