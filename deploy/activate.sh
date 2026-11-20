#!/bin/sh
# Run from an extracted, verified git release on the existing production server.
set -eu
release=${1:?Usage: sh deploy/activate.sh COMMIT_SHA}
case "$release" in *[!0-9a-f]*|'') echo 'Invalid commit SHA' >&2; exit 1;; esac
[ "${#release}" -eq 40 ] || { echo 'Expected full commit SHA' >&2; exit 1; }
export RELEASE="$release"
base=/opt/jiujitsu-reference
config=/opt/bjjchat/nginx/conf.d/00-jiujitsutools-reference.conf
mkdir -p "$base/backups"
backup=$(mktemp -d "$base/backups/$release-XXXXXX")
if [ -f "$config" ]; then cp "$config" "$backup/previous.conf"; fi
if [ -f "$base/current-release" ]; then cp "$base/current-release" "$backup/previous-release"; fi

restore_app() {
    if [ -f "$backup/previous-release" ]; then
        previous=$(cat "$backup/previous-release")
        (cd "$base/releases/$previous" && RELEASE="$previous" docker compose -f deploy/compose.yml up -d)
    fi
}

docker compose -f deploy/compose.yml build
if ! docker compose -f deploy/compose.yml up -d; then
    restore_app
    echo 'Container replacement failed; previous app restored when available' >&2
    exit 1
fi
attempt=0
until docker exec jiujitsu-reference node -e "fetch('http://127.0.0.1:7100/',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok || !(await r.text()).includes('Jiu Jitsu Tools'))process.exit(1)}).catch(()=>process.exit(1))"; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 10 ] || { restore_app; echo 'New app failed health check; proxy unchanged' >&2; exit 1; }
    sleep 2
done

restore_proxy() {
    if [ -f "$backup/previous.conf" ]; then
        cp "$backup/previous.conf" "$config"
    else
        rm -f "$config"
    fi
    docker exec bjj-nginx nginx -t && docker exec bjj-nginx nginx -s reload
    restore_app
}

cp deploy/00-jiujitsutools-reference.conf "$config"
if ! docker exec bjj-nginx nginx -t; then restore_proxy; exit 1; fi
if ! docker exec bjj-nginx nginx -s reload; then restore_proxy; exit 1; fi
if ! curl --fail --silent --show-error --retry 3 --retry-delay 2 --max-time 15 https://jiujitsutools.com/ | grep -q 'Jiu Jitsu Tools'; then
    restore_proxy
    echo 'Public smoke test failed; previous proxy restored' >&2
    exit 1
fi
printf '%s\n' "$release" > "$base/current-release"
echo "Published $release at https://jiujitsutools.com/"
