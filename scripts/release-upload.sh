#!/usr/bin/env bash
# Publish the tarballs of a release under two names.
#
#   ./scripts/release-upload.sh v0.9.33
#
# The README installs from
#   https://github.com/<owner>/<repo>/releases/latest/download/dsh-openfoam-workbench.tgz
# which GitHub resolves to the *newest* release. That only works while every
# release carries an asset with that exact stable name, so both are uploaded:
# the stable one for installers and the version-named one for pinning.
#
# Requires: a pushed tag, an authenticated `gh`, and a clean tree.
set -euo pipefail

tag="${1:?usage: release-upload.sh vX.Y.Z}"
version="${tag#v}"
repo="$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"
pkg="$(node -p "require('./package.json').name")"
file="$(npm pack --silent)"          # <name>-<version>.tgz, gitignored

stable="dsh-openfoam-workbench.tgz"
trap 'rm -f "$file" "$stable"' EXIT
cp "$file" "$stable"

echo "release: $tag ($repo) as $pkg@$version"
gh release view "$tag" >/dev/null || {
  echo "no release for $tag yet - create it first:" >&2
  echo "  gh release create $tag --title ... --notes-file ..." >&2
  exit 1
}

gh release upload "$tag" "$file" "$stable" --clobber
gh release view "$tag" --json assets -q '.assets[] | .name + " " + (.size|tostring)'

url="https://github.com/$repo/releases/latest/download/$stable"
if [ "$(gh release view --json tagName -q .tagName)" = "$tag" ]; then
  echo "stable install URL: $url"
  curl -sIL -o /dev/null -w '  resolves: %{http_code}\n' "$url"
fi
