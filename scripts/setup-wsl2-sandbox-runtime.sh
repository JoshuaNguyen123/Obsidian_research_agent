#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
shift || true

if [[ "$mode" == "provision" ]]; then
  runtime_root="${1:?runtime root required}"
  entrypoint_source="${2:?entrypoint source required}"
  [[ "$runtime_root" == /opt/agentic/* && "$runtime_root" != *".."* ]] || {
    echo "runtime root must stay below /opt/agentic" >&2
    exit 64
  }
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends bubblewrap python3
  if ! id agentic >/dev/null 2>&1; then
    useradd --system --uid 65532 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin agentic
  fi
  next_root="${runtime_root}.next"
  rm -rf "$next_root"
  mkdir -p "$next_root/bin" "$next_root/lib" "$next_root/lib64"
  python_path="$(command -v python3)"
  python_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  cp -L "$python_path" "$next_root/bin/python3"
  cp -a "/usr/lib/python${python_version}" "$next_root/lib/"
  cp "$entrypoint_source" "$next_root/bin/sandbox-entrypoint"
  sed -i '1c #!/runtime/bin/python3' "$next_root/bin/sandbox-entrypoint"

  collect_deps() {
    ldd "$1" 2>/dev/null | awk '/=> \// { print $3 } /^[[:space:]]*\// { print $1 }' || true
  }
  targets=("$python_path")
  while IFS= read -r module; do targets+=("$module"); done < <(
    find "/usr/lib/python${python_version}" -type f -name '*.so' -print
  )
  for target in "${targets[@]}"; do
    while IFS= read -r dependency; do
      [[ -n "$dependency" ]] || continue
      destination="$next_root$dependency"
      mkdir -p "$(dirname "$destination")"
      cp -L "$dependency" "$destination"
    done < <(collect_deps "$target")
  done
  chmod 0555 "$next_root/bin/python3" "$next_root/bin/sandbox-entrypoint"
  find "$next_root" -type d -exec chmod 0555 {} +
  rm -rf "$runtime_root"
  mv "$next_root" "$runtime_root"
  chown -R root:root "$runtime_root"
  exit 0
fi

if [[ "$mode" == "identity" ]]; then
  runtime_root="${1:?runtime root required}"
  runtime_digest="${2:?runtime digest required}"
  manifest="${3:?runtime manifest required}"
  [[ "$runtime_root" == /opt/agentic/* && "$runtime_root" != *".."* ]] || {
    echo "runtime root must stay below /opt/agentic" >&2
    exit 64
  }
  printf '%s\n' "$runtime_digest" > "$runtime_root/.agentic-runtime-digest"
  printf '%s\n' "$manifest" > "$runtime_root/runtime-manifest.json"
  chmod 0444 "$runtime_root/.agentic-runtime-digest" "$runtime_root/runtime-manifest.json"
  exit 0
fi

echo "usage: setup-wsl2-sandbox-runtime.sh provision|identity ..." >&2
exit 64
