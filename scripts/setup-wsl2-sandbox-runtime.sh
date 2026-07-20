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
  apt-get install -y --no-install-recommends bubblewrap dash nodejs npm python3
  if ! id agentic >/dev/null 2>&1; then
    useradd --system --uid 65532 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin agentic
  fi
  next_root="${runtime_root}.next"
  rm -rf "$next_root"
  mkdir -p "$next_root/bin" "$next_root/lib" "$next_root/lib64"
  python_path="$(command -v python3)"
  node_path="$(command -v node)"
  shell_path="$(command -v dash)"
  python_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  cp -L "$python_path" "$next_root/bin/python3"
  cp -L "$python_path" "$next_root/bin/python"
  cp -L "$node_path" "$next_root/bin/node"
  cp -L "$shell_path" "$next_root/bin/sh"
  cp -a "/usr/lib/python${python_version}" "$next_root/lib/"
  cp -aL /usr/share/nodejs "$next_root/lib/"
  cat > "$next_root/bin/npm" <<'EOF'
#!/runtime/bin/node
require("/runtime/lib/nodejs/npm/bin/npm-cli.js");
EOF
  cp "$entrypoint_source" "$next_root/bin/sandbox-entrypoint"
  sed -i '1c #!/runtime/bin/python3' "$next_root/bin/sandbox-entrypoint"

  collect_deps() {
    ldd "$1" 2>/dev/null | awk '/=> \// { print $3 } /^[[:space:]]*\// { print $1 }' || true
  }
  targets=("$python_path" "$node_path" "$shell_path")
  while IFS= read -r module; do targets+=("$module"); done < <(
    find "/usr/lib/python${python_version}" -type f -name '*.so' -print
  )
  while IFS= read -r module; do targets+=("$module"); done < <(
    find /usr/share/nodejs -type f -name '*.node' -print
  )
  for target in "${targets[@]}"; do
    while IFS= read -r dependency; do
      [[ -n "$dependency" ]] || continue
      destination="$next_root$dependency"
      mkdir -p "$(dirname "$destination")"
      cp -L "$dependency" "$destination"
    done < <(collect_deps "$target")
  done
  chmod 0555 \
    "$next_root/bin/node" \
    "$next_root/bin/npm" \
    "$next_root/bin/python" \
    "$next_root/bin/python3" \
    "$next_root/bin/sandbox-entrypoint" \
    "$next_root/bin/sh"
  find "$next_root" -type d -exec chmod 0555 {} +
  rm -rf "$runtime_root"
  mv "$next_root" "$runtime_root"
  chown -R root:root "$runtime_root"
  exit 0
fi

if [[ "$mode" == "fingerprint" ]]; then
  runtime_root="${1:?runtime root required}"
  [[ "$runtime_root" == /opt/agentic/* && "$runtime_root" != *".."* ]] || {
    echo "runtime root must stay below /opt/agentic" >&2
    exit 64
  }
  python3 - "$runtime_root" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
digest = hashlib.sha256()
excluded = {".agentic-runtime-digest", "runtime-manifest.json"}
for folder, directories, files in os.walk(root):
    directories.sort()
    files.sort()
    for name in files:
        relative = os.path.relpath(os.path.join(folder, name), root).replace(os.sep, "/")
        if relative in excluded:
            continue
        path = os.path.join(root, relative.replace("/", os.sep))
        mode = stat.S_IMODE(os.lstat(path).st_mode)
        digest.update(f"{relative}\0{mode:o}\0".encode("utf-8"))
        if os.path.islink(path):
            digest.update(b"link\0")
            digest.update(os.readlink(path).encode("utf-8"))
        else:
            digest.update(b"file\0")
            with open(path, "rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
        digest.update(b"\0")
print(f"sha256:{digest.hexdigest()}")
PY
  exit 0
fi

if [[ "$mode" == "identity" ]]; then
  runtime_root="${1:?runtime root required}"
  runtime_digest="${2:?runtime digest required}"
  [[ "$runtime_root" == /opt/agentic/* && "$runtime_root" != *".."* ]] || {
    echo "runtime root must stay below /opt/agentic" >&2
    exit 64
  }
  [[ "$runtime_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo "runtime digest must be an exact SHA-256 fingerprint" >&2
    exit 64
  }
  printf '%s\n' "$runtime_digest" > "$runtime_root/.agentic-runtime-digest"
  python3 - "$runtime_root/runtime-manifest.json" "$runtime_digest" <<'PY'
import json
import sys

path, runtime_digest = sys.argv[1:]
manifest = {
    "version": 1,
    "commandRuntimeDigests": {
        runtime_digest: ["node", "npm", "python", "python3"],
    },
}
with open(path, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(manifest, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
  chmod 0444 "$runtime_root/.agentic-runtime-digest" "$runtime_root/runtime-manifest.json"
  exit 0
fi

echo "usage: setup-wsl2-sandbox-runtime.sh provision|fingerprint|identity ..." >&2
exit 64
