#!/usr/bin/env bash
# Remove every OpenFOAM.com (ESI) installation from this machine and install it
# fresh from the official apt repository, then smoke-test the rho solvers.
#
# Run it yourself: it needs root (sudo). It does NOT touch openfoam.org (/opt/openfoam14).
#
#   bash scripts/reinstall-com.sh            # archive the user builds, then remove
#   bash scripts/reinstall-com.sh --no-backup # remove without archiving
set -euo pipefail

BACKUP=1
[ "${1:-}" = "--no-backup" ] && BACKUP=0

HOME_DIR="${HOME:-/home/$USER}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$HOME_DIR/openfoam-com-backup-$STAMP.tar.gz"

# 1. Everything com-related that lives in the user's home.
USER_COM_DIRS=(
  "$HOME_DIR/OpenFOAM/openfoam2606-multicomponent-wang"
  "$HOME_DIR/OpenFOAM/yakovlev-i-a-v2606"
  "$HOME_DIR/OpenFOAM/yakovlev-i-a-v2606wang"
  "$HOME_DIR/OpenFOAM/yakovlev-i-a-v2306"
)

existing=()
for d in "${USER_COM_DIRS[@]}"; do [ -e "$d" ] && existing+=("$d"); done

if [ "${#existing[@]}" -gt 0 ]; then
  if [ "$BACKUP" = 1 ]; then
    echo "archiving ${existing[*]}"
    echo "        -> $BACKUP_FILE"
    tar -czf "$BACKUP_FILE" -C "$HOME_DIR/OpenFOAM" $(for d in "${existing[@]}"; do basename "$d"; done)
  fi
  for d in "${existing[@]}"; do
    echo "removing $d"
    rm -rf -- "$d"
  done
fi

# 2. apt packages (this is how com is installed on this machine).
echo "purging apt packages"
sudo apt-get purge -y 'openfoam2606*' || true
sudo apt-get autoremove -y || true

# 3. Leftovers of the system install.
if [ -d /usr/lib/openfoam/openfoam2606 ]; then
  echo "removing /usr/lib/openfoam/openfoam2606"
  sudo rm -rf /usr/lib/openfoam/openfoam2606
fi

# 4. Fresh install from the official openfoam.com repository.
echo "refreshing the openfoam.com apt repository"
if [ ! -f /etc/apt/sources.list.d/openfoam.list ]; then
  curl -s https://dl.openfoam.com/add-debian-repo.sh | sudo bash
fi
sudo apt-get update
sudo apt-get install -y openfoam2606-dev

# 4b. The apt install normally re-registers itself with openfoam-selector.
echo "=== openfoam-selector"
openfoam-selector --list 2>&1 | head -8 || true
if ! openfoam-selector --list 2>/dev/null | grep -q 'openfoam2606'; then
  echo "registering openfoam2606 with the selector"
  sudo openfoam-selector --register openfoam2606 --source-dir /usr/lib/openfoam/openfoam2606 || true
fi

# 5. Verify: version and the solver that used to segfault.
echo
echo "=== installed version"
bash -lc 'source /usr/lib/openfoam/openfoam2606/etc/bashrc >/dev/null 2>&1; echo "$WM_PROJECT_VERSION"'

WORK="$(mktemp -d)"
echo "=== smoke test: shipped rhoPimpleFoam tutorial in $WORK"
cp -r /usr/lib/openfoam/openfoam2606/tutorials/compressible/rhoPimpleFoam/LES/pitzDaily/. "$WORK/"
(
  cd "$WORK"
  bash -lc 'source /usr/lib/openfoam/openfoam2606/etc/bashrc >/dev/null 2>&1; cd "'"$WORK"'"; blockMesh >/dev/null && timeout 120 rhoPimpleFoam > solver.log 2>&1; tail -3 solver.log'
)
echo
echo "if the solver printed 'End' the installation is healthy; remove $WORK when done"
echo "backup: $([ -f "$BACKUP_FILE" ] && echo "$BACKUP_FILE" || echo 'none')"
