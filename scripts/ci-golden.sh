#!/usr/bin/env bash
# Runs inside an OpenFOAM container (see .github/workflows/golden.yml).
# Bootstraps Node if the image has none, then runs the golden cases.
set -euo pipefail
export HOME="${HOME:-/tmp}"

if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates xz-utils >/dev/null
  fi
  curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  mkdir -p /opt/node22
  tar -xJf /tmp/node.tar.xz -C /opt/node22 --strip-components=1
  export PATH=/opt/node22/bin:$PATH
fi

# The image may not export WM_PROJECT_DIR for a non-interactive shell: locate the
# installation and hand it to the runner, which also uses it for discovery.
if [ -z "${WM_PROJECT_DIR:-}" ]; then
  for f in /opt/[Oo]pen[Ff][Oo][Aa][Mm]*/etc/bashrc /opt/openfoam*/etc/bashrc \
           /usr/lib/openfoam/openfoam*/etc/bashrc /usr/local/[Oo]pen[Ff][Oo][Aa][Mm]*/etc/bashrc \
           "$HOME"/[Oo]pen[Ff][Oo][Aa][Mm]*/etc/bashrc /home/*/[Oo]pen[Ff][Oo][Aa][Mm]*/etc/bashrc \
           /root/[Oo]pen[Ff][Oo][Aa][Mm]*/etc/bashrc; do
    if [ -f "$f" ]; then
      export WM_PROJECT_DIR="$(cd "$(dirname "$f")/.." && pwd)"
      break
    fi
  done
fi
if [ -z "${WM_PROJECT_DIR:-}" ]; then
  # last resort: the images install wherever the build user kept the source
  found="$(find / -maxdepth 6 -type f -name bashrc -path '*[Oo]pen[Ff][Oo][Aa][Mm]*/etc/bashrc' 2>/dev/null | head -1)"
  if [ -n "$found" ]; then
    export WM_PROJECT_DIR="$(cd "$(dirname "$found")/.." && pwd)"
  fi
fi
if [ -n "${WM_PROJECT_DIR:-}" ]; then
  export WM_PROJECT_VERSION="$(basename "$WM_PROJECT_DIR" | sed -e 's/^[Oo]pen[Ff][Oo][Aa][Mm]-//')"
fi
echo "installation: ${WM_PROJECT_DIR:-none}"

node --version
node scripts/run-golden.mjs --distribution "${DIST:?DIST is required}"
