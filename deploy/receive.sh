#!/bin/sh
# Installed outside release directories and invoked only by a forced SSH command.
set -eu
release=${SSH_ORIGINAL_COMMAND:-}
case "$release" in *[!0-9a-f]*|'') echo 'Expected one lowercase commit SHA' >&2; exit 1;; esac
[ "${#release}" -eq 40 ] || { echo 'Expected full commit SHA' >&2; exit 1; }
base=/opt/jiujitsu-reference
repository="$base/repository.git"

# Serialize remote calls as well as GitHub jobs. Never interrupt an activation.
exec 9>"$base/deploy.lock"
flock -w 600 9

git --git-dir="$repository" fetch --no-tags origin +refs/heads/main:refs/heads/main
main=$(git --git-dir="$repository" rev-parse refs/heads/main)
[ "$release" = "$main" ] || { echo 'Rejected: commit is no longer main' >&2; exit 1; }

mkdir -p "$base/releases"
if [ ! -d "$base/releases/$release" ]; then
    staging=$(mktemp -d "$base/releases/.incoming-XXXXXX")
    trap 'rm -rf "$staging"' 0
    trap 'exit 1' 1 2 15
    mkdir "$staging/tree"
    # Separate archive creation from extraction so either failure stops deployment.
    git --git-dir="$repository" archive --format=tar --output="$staging/source.tar" "$release"
    tar -xf "$staging/source.tar" -C "$staging/tree"
    mv "$staging/tree" "$base/releases/$release"
fi
cd "$base/releases/$release"
sh deploy/activate.sh "$release"
