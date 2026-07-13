# Sandbox runtime protocol v1

`sandbox-entrypoint.py` is installed inside the sandbox runtime; the Obsidian
plugin never launches it directly on the host.

OCI images must install it as `/opt/agentic/sandbox-entrypoint`, make it owned
by root and executable but not writable by UID `65532`, and include:

- `/opt/agentic/runtime-digest` containing the exact OCI image digest configured in the plugin.
- `/opt/agentic/runtime-manifest.json` using the closed schema in
  `runtime-manifest.example.json`.

Dedicated WSL2/bubblewrap roots install it as
`/runtime/bin/sandbox-entrypoint` after the host read-only bind, with identity
files at `/runtime/.agentic-runtime-digest` and
`/runtime/runtime-manifest.json`.

The runtime manifest binds repository/runtime pin hashes to an exact command
catalog. A runtime must be rebuilt when a new immutable runtime identity is
approved. Do not put credentials in the image, manifest, command environment,
or staging bundle.

The boundary probe deliberately fails unless the process is non-root, root and
runtime mounts are read-only, `/workspace` is isolated tmpfs, no host root or
container socket is visible, the network has no default route, and CPU, memory,
and PID limits are observable. Failure leaves the code extension in
editing-only mode; there is no native execution fallback.
