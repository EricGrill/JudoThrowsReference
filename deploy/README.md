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

## Publish a reviewed commit

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
