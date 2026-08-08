#!/usr/bin/env bash
# Create the development sidecar shims Tauri expects in src-tauri/binaries/.
#
# `externalBin` requires a file per target triple to exist before `tauri dev`
# or `tauri build` will run. In development those files are these shims; the
# release workflow stages the real PyInstaller / cargo-built binaries instead.
# Neither is tracked in git — bundling a shim would ship it.
#
# Usage: scripts/dev-sidecars.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
DIR="src-tauri/binaries"
mkdir -p "$DIR"

cat > "$DIR/docfindy-engine-$TRIPLE" <<'SHIM'
#!/usr/bin/env bash
# Dev shim: forwards to the Python engine in the repo venv. Tauri copies this
# next to the app binary, so walk up from wherever we ended up to find engine/.
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [ "$D" != "/" ] && [ ! -f "$D/engine/main.py" ]; do
  D="$(dirname "$D")"
done
if [ ! -f "$D/engine/main.py" ]; then
  echo "docfindy-engine dev shim: engine/main.py not found above $0" >&2
  exit 1
fi
exec "$D/engine/.venv/bin/python" "$D/engine/main.py" "$@"
SHIM

cat > "$DIR/rtk-$TRIPLE" <<'SHIM'
#!/usr/bin/env bash
# Dev shim: use a real rtk when one is installed, otherwise fail. Failing is
# the right answer — src-tauri/src/rtk.rs falls back to its own walkdir scan
# when the sidecar does not succeed. (An `exec "$@"` passthrough here would
# run whatever argument list it was handed, which is not something to keep
# around in a tree that also gets bundled.)
set -euo pipefail
if command -v rtk >/dev/null 2>&1; then
  exec rtk "$@"
fi
echo "rtk dev shim: rtk not on PATH; caller falls back to the built-in scan" >&2
exit 127
SHIM

chmod +x "$DIR/docfindy-engine-$TRIPLE" "$DIR/rtk-$TRIPLE"
echo "wrote $DIR/docfindy-engine-$TRIPLE and $DIR/rtk-$TRIPLE"
