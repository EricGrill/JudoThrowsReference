# Production deployment

The custom domain is registered at Namecheap. Its authoritative DNS is DigitalOcean,
already pointing to the BJJChat server at 157.230.57.215. No registrar transfer or DNS
change is needed for this launch.

The reference app runs as the independent `jiujitsu-reference` Docker Compose project
on the external `bjjchat_bjj-network`. It has no published host port, database, secrets,
or writable application volume. The existing tools service remains running and serves
the calculator, timer, blog, and Next.js asset routes.

`00-jiujitsutools-reference.conf` loads before the existing microsite definitions. It
owns the apex and www hostnames, redirects HTTP and www to the canonical HTTPS apex,
and uses the existing certificate. Other virtual hosts are unchanged. The BJJChat
deployment copies its tracked config files without deleting this separate override,
and its orphan cleanup is scoped to its own Compose project. An explicit default
virtual host preserves the previous shared-server fallback: the BJJChat certificate
and a redirect to its apex for unmatched hostnames.

## Automatic deployment from main

`.github/workflows/deploy.yml` runs the tests, JavaScript checks, and shell syntax
checks on pull requests and pushes to `main`. Only a successful push-to-main run
can enter the deployment job. This site is hosted on DigitalOcean with Docker,
so Vercel Git integration does not deploy it.

The job sends only the tested full commit SHA over SSH. The server's forced
`deploy/receive.sh` command rejects everything except one lowercase 40-character
SHA, locks deployment, fetches the public repository over HTTPS, and requires the
requested commit to equal current `main`. A superseded run fails instead of
replacing production with an older release. Archive creation and extraction must
both succeed before an immutable release directory is activated. Existing
activation health checks and rollback behavior remain in effect. After activation,
the workflow compares the public HTML byte-for-byte with the tested commit and
checks the calculator, timer, size calculator, and blog routes. Failure of these
additional checks marks the run failed for operator investigation; the workflow
does not automatically roll back a successfully activated release.

GitHub concurrency serializes production jobs without canceling a running
activation. The receiver also holds a server lock, with a ten-minute wait limit.
The deployment job has a twenty-minute timeout. Inspect the failed Actions run
before retrying; retry only a run for current `main`.

## One-time server setup and credentials

The deployment base is `/opt/jiujitsu-reference`, in the server's `opt` folder.
The public repository is `https://github.com/EricGrill/JudoThrowsReference.git`.
Create its bare checkout at `/opt/jiujitsu-reference/repository.git`, with that
HTTPS origin. A GitHub read key is unnecessary because the source is public.
The server needs Git, `flock`, tar, Docker Compose, and curl.

Install the reviewed receiver as `/opt/jiujitsu-reference/receive.sh`, owned by
root and writable only by root. It is deliberately outside the release tree;
receiver changes require a separate reviewed install. Keep the server's existing
operator SSH access. Add a dedicated CI public key to root's authorized keys with
these restrictions:

```text
restrict,command="sh /opt/jiujitsu-reference/receive.sh" ssh-ed25519 PUBLIC_KEY reference-production
```

`restrict` disables forwarding, PTY allocation, and user startup commands. The
forced receiver does not evaluate the client's command as shell syntax. The
installed receiver still executes deployment code from trusted `main`, so protect
write access to that branch and the workflow.

Set repository secret `REFERENCE_DEPLOY_KEY` to this dedicated private key. Set
`REFERENCE_KNOWN_HOSTS` to the server's verified SSH host-key entry for
`157.230.57.215`. Verify its fingerprint through existing trusted operator access;
do not trust an unauthenticated key scan by itself. The workflow uses strict host
checking and removes its temporary credential files on exit. Rotate the key by
replacing the restricted authorized-key entry and the repository secret together.

After bootstrap, merge a tested change and verify the automatic deployment run,
`/opt/jiujitsu-reference/current-release`, and the public page against that commit.
The current-release file lives in the server's `jiujitsu-reference` folder.

## Manual recovery: publish a reviewed commit

Run tests before publishing. From the repository, set `release` to the full reviewed
git commit and copy only tracked files:

```sh
npm test
npm run check
release=$(git rev-parse HEAD)
ssh bjjchat-prod "mkdir -p /opt/jiujitsu-reference/releases/$release"
git archive "$release" | ssh bjjchat-prod "tar -xf - -C /opt/jiujitsu-reference/releases/$release"
ssh bjjchat-prod "cd /opt/jiujitsu-reference/releases/$release && sh deploy/activate.sh $release"
```

The activation script builds the release, checks the new app, validates nginx, reloads
it, and checks the public page. Configuration backups and the prior release marker
live in unique `/opt/jiujitsu-reference/backups/<commit>-<activation>` directories on
the server. No credentials are
copied into the image or source repository.

## Rollback

For later releases, activate the prior commit from its retained release directory.
The image and source remain tagged by commit. To undo the initial migration, remove
only `/opt/bjjchat/nginx/conf.d/00-jiujitsutools-reference.conf`, validate nginx, and
reload it. The unchanged legacy configuration and container resume serving the root.
Do not stop the legacy tools container: bookmarked calculators and timers still use it.

## Verification

Check HTTPS on the apex, HTTP and www redirects, all 68 throws, filtering, selection,
notes persistence, the context-aware YouTube link, and video API fallback. Confirm
existing calculators and timers still return successful responses. Video results
depend on external providers; direct YouTube search remains available during outages.

The existing shared nginx configuration emits duplicate-host warnings for legacy
microsites. The dedicated override deliberately loads first for this domain. A syntax
check must still succeed before any reload.
