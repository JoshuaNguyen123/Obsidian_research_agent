from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from service_manager import (
    build_service_spec,
    install_service,
    load_bootstrap_token,
    service_status,
    uninstall_service,
)
from config import validate_approved_data_boundary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install, inspect, remove, or securely pair the local companion."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("install", "status", "remove", "preflight"):
        command = commands.add_parser(name)
        command.add_argument("--data-dir", type=Path, required=True)
        command.add_argument("--approved-data-root", type=Path, required=True)
        command.add_argument("--port", type=int, default=8765)
        command.add_argument("--node-executable", type=Path, required=True)
    commands.choices["remove"].add_argument(
        "--remove-bootstrap-token", action="store_true"
    )
    commands.choices["remove"].add_argument(
        "--remove-host-approval-signing-key", action="store_true"
    )
    token = commands.add_parser("token")
    token.add_argument("--data-dir", type=Path, required=True)
    token.add_argument("--approved-data-root", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "token":
        # This command is intentionally machine-facing. The extension captures
        # stdout through a private pipe and immediately retains it only inside
        # its authenticated-client closure. No newline or diagnostic includes it.
        validate_approved_data_boundary(args.approved_data_root, args.data_dir)
        sys.stdout.write(load_bootstrap_token().get_secret_value())
        sys.stdout.flush()
        return

    companion_dir = Path(__file__).resolve().parent
    spec = build_service_spec(
        companion_dir=companion_dir,
        data_dir=args.data_dir,
        approved_data_root=args.approved_data_root,
        port=args.port,
        node_executable=args.node_executable,
    )
    if args.command == "preflight":
        from runtime_preflight import verify_runtime

        checked = verify_runtime(companion_dir, spec.node_executable)
        result = {
            "ok": checked.ok,
            "action": "preflight",
            "platform": spec.platform,
            "runtimeReady": checked.ok,
            "runtimeBlocker": checked.blocker,
            "runtimeRequiredAction": checked.required_action,
        }
    elif args.command == "install":
        install_service(spec)
        result = {"ok": True, "action": "installed", "platform": spec.platform}
    elif args.command == "remove":
        uninstall_service(
            spec,
            remove_bootstrap_token=args.remove_bootstrap_token,
            remove_host_approval_signing_key=args.remove_host_approval_signing_key,
        )
        result = {"ok": True, "action": "removed", "platform": spec.platform}
    else:
        result = {"ok": True, **service_status(spec)}
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
