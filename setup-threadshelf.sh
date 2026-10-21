#!/usr/bin/env bash
# ThreadShelf Enhanced: portable, project-local runtime; no sudo required.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION="${THREADSHELF_NODE_VERSION:-24.22.1}"
NPM_VERSION="${THREADSHELF_NPM_VERSION:-12.2.1}"
START=0
RUNTIME_ONLY=0
while (($#)); do
  case "$1" in
    --start) START=1 ;;
    --runtime-only) RUNTIME_ONLY=1 ;;
    --node-version) shift; NODE_VERSION="${1:?Missing Node version}" ;;
    --npm-version) shift; NPM_VERSION="${1:?Missing npm version}" ;;
    --help|-h) echo 'Usage: bash setup-threadshelf.sh [--start] [--runtime-only] [--node-version 24.22.1] [--npm-version 12.2.1]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
NODE_VERSION="${NODE_VERSION#v}"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid Node version' >&2; exit 2; }
[[ "$NPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid npm version' >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { echo 'This script supports Linux. Use setup-threadshelf.ps1 on Windows.' >&2; exit 1; }
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo 'Supported Linux architectures: x64, arm64.' >&2; exit 1 ;; esac
command -v tar >/dev/null && command -v sha256sum >/dev/null || { echo 'tar and sha256sum are required.' >&2; exit 1; }
fetch() {
  if command -v curl >/dev/null; then curl --fail --location --retry 3 --connect-timeout 20 --output "$2" "$1"
  elif command -v wget >/dev/null; then wget --https-only --tries=3 --timeout=30 -O "$2" "$1"
  else echo 'Install curl or wget first.' >&2; return 1; fi
}
mkdir -p "$ROOT/.local"
RUNTIME="$ROOT/.local/node-v${NODE_VERSION}-linux-${ARCH}"
if [[ ! -x "$RUNTIME/bin/node" ]] || [[ "$("$RUNTIME/bin/node" --version)" != "v$NODE_VERSION" ]]; then
  STAGE="$(mktemp -d "$ROOT/.local/node-download.XXXXXX")"
  trap 'rm -rf -- "$STAGE"' EXIT
  ARCHIVE="node-v${NODE_VERSION}-linux-${ARCH}.tar.gz"
  BASE="https://nodejs.org/dist/v${NODE_VERSION}"
  fetch "$BASE/$ARCHIVE" "$STAGE/$ARCHIVE"
  fetch "$BASE/SHASUMS256.txt" "$STAGE/SHASUMS256.txt"
  EXPECTED="$(awk -v name="$ARCHIVE" '$2 == name {print $1}' "$STAGE/SHASUMS256.txt")"
  [[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'No valid official checksum found.' >&2; exit 1; }
  printf '%s  %s\n' "$EXPECTED" "$STAGE/$ARCHIVE" | sha256sum --check -
  tar --no-same-owner -xzf "$STAGE/$ARCHIVE" -C "$STAGE"
  [[ "$("$STAGE/node-v${NODE_VERSION}-linux-${ARCH}/bin/node" --version)" == "v$NODE_VERSION" ]] || { echo 'Downloaded Node cannot run on this system.' >&2; exit 1; }
  if [[ -e "$RUNTIME" ]]; then mv "$RUNTIME" "$STAGE/previous-runtime"; fi
  mv "$STAGE/node-v${NODE_VERSION}-linux-${ARCH}" "$RUNTIME"
  rm -rf -- "$STAGE"
  trap - EXIT
fi
export PATH="$RUNTIME/bin:$PATH"
# Embeddings use the bundled CPU runtime; optional CUDA downloads are unnecessary.
export ONNXRUNTIME_NODE_INSTALL="${ONNXRUNTIME_NODE_INSTALL:-skip}"
export npm_config_cache="$ROOT/.local/npm-cache"
export npm_config_prefix="$RUNTIME"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.local/cache}"
export HF_HOME="${HF_HOME:-$ROOT/.local/huggingface}"
cd "$ROOT"
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node 24 or newer required")'
if [[ "$(npm --version)" != "$NPM_VERSION" ]]; then
  # --global is confined to this explicit project-local prefix, never the OS.
  npm install --global --prefix "$RUNTIME" "npm@$NPM_VERSION" \
    --registry=https://registry.npmjs.org --engine-strict --ignore-scripts --no-audit --no-fund
  hash -r
fi
[[ "$(npm --version)" == "$NPM_VERSION" ]] || { echo 'Local npm version verification failed.' >&2; exit 1; }
printf 'Using Node %s and npm %s (project-local)\n' "$(node --version)" "$(npm --version)"
if ((RUNTIME_ONLY)); then echo "Runtime ready: $RUNTIME"; exit 0; fi
[[ -f package-lock.json ]] || { echo 'Run this script from the unpacked source release.' >&2; exit 1; }
if [[ ! -e .env ]]; then cp .env.example .env; echo 'Created .env; review HOST, PORT and ALLOWED_HOSTS before network access.'; fi
npm ci --include=dev --no-audit --no-fund
npm run build
printf '\nThreadShelf Enhanced is ready. Start it with: bash setup-threadshelf.sh --start\n'
if ((START)); then exec node dist/src/server.js; fi
