# Companion Runtime Data

This folder is for local companion runtime data such as SQLite memory,
coordinator jobs/events/receipts, secret-reference metadata, screenshots, and
browser artifacts.

Credential plaintext is never stored here. Persistent values live in the OS
credential store; SQLite contains opaque references and non-secret metadata.
Job lease tokens are stored only as SHA-256 hashes. Foreground session secrets
exist only in process memory.

The companion data directory must not be placed inside an Obsidian vault. The
companion exposes no vault filesystem API and rejects vault payload fields.

Only this README and `.gitkeep` should be committed. Runtime files are intentionally ignored.
