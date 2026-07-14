from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal
from typing import Any, Literal


Domain = Literal["research", "code", "linear", "github", "companion"]
FINGERPRINT_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
STABLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
OPAQUE_REFERENCE_PATTERN = re.compile(
    r"^(?:secret|credential)_[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$"
)

_SECRET_MARKERS = (
    "token",
    "password",
    "secret",
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "privatekey",
    "clientsecret",
    "credential",
)
_SECRET_REFERENCE_KEYS = {"secretref", "credentialref"}
_COMMAND_KEYS = {
    "args",
    "argv",
    "cmd",
    "command",
    "commands",
    "executable",
    "script",
    "shell",
    "workingdirectory",
}
_VAULT_MARKERS = (
    "vault",
    "obsidian",
    "notepath",
    "notecontent",
    ".obsidian",
)
_ABSOLUTE_WINDOWS = re.compile(r"^[A-Za-z]:[\\/]")
_UNC_PATH = re.compile(r"^(?:\\\\|//)[^/\\]+[/\\]")

_INPUT_KEYS: dict[str, set[str]] = {
    "research": {
        "artifactbinding",
        "binding",
        "constraints",
        "credentialref",
        "language",
        "maxsources",
        "objective",
        "prompt",
        "queries",
        "query",
        "scope",
        "secretref",
        "sourcebinding",
        "sourceurls",
        "topic",
        "urls",
    },
    "code": {
        "artifactbinding",
        "baseRef".lower(),
        "binding",
        "constraints",
        "credentialref",
        "headref",
        "issueid",
        "objective",
        "patchfingerprint",
        "pullrequestnumber",
        "repositorybinding",
        "repositorybindingid",
        "secretref",
        "specification",
        "task",
        "workspacebinding",
        "workspacebindingid",
    },
    "linear": {
        "acceptancecriteria",
        "binding",
        "candidatefingerprint",
        "contractfingerprint",
        "credentialref",
        "credentialreferenceid",
        "issueid",
        "objective",
        "projectbinding",
        "projectbindingid",
        "queuecandidatefingerprint",
        "secretref",
        "state",
        "teambinding",
        "teambindingid",
        "workitemid",
    },
    "github": {
        "baseref",
        "binding",
        "bodyfingerprint",
        "credentialref",
        "headref",
        "issueid",
        "issuenumber",
        "objective",
        "pullrequestnumber",
        "repositorybinding",
        "repositorybindingid",
        "secretref",
        "sha",
    },
}

_BINDING_KINDS: dict[str, set[str]] = {
    "research": {"research-source", "research_source", "web-source", "web_source"},
    "code": {
        "code-workspace",
        "repository",
        "repository-workspace",
        "repository-profile",
        "trusted-repository",
        "workspace",
    },
    "linear": {
        "external-work-item",
        "issue",
        "linear-project",
        "linear-team",
        "linear-work-item",
    },
    "github": {"github-branch", "github-pull-request", "github-repository", "repository"},
}

_RECEIPT_KEYS: dict[str, set[str]] = {
    "research": {
        "acceptedartifactfingerprint",
        "artifactfingerprint",
        "evidencefingerprint",
        "sourcecount",
        "sourceurls",
    },
    "code": {
        "artifacthashes",
        "attemptid",
        "checkpointsequence",
        "commitsha",
        "diffhash",
        "failurefingerprint",
        "handofffingerprint",
        "repaircheckpointid",
        "repairrequestfingerprint",
        "repositoryprofilefingerprint",
        "sandboxcapabilityfingerprint",
        "validationhash",
        "verifiedcommitreceiptfingerprint",
        "workspacebindingfingerprint",
    },
    "linear": {
        "attemptid",
        "candidatefingerprint",
        "handofffingerprint",
        "identifier",
        "issueid",
        "issueurl",
        "observedstateid",
        "observedupdatedat",
        "preconditionfingerprint",
        "preparedactionfingerprint",
        "readbackfingerprint",
        "reconciliationmode",
        "state",
        "targetstateid",
        "updatedat",
        "workitemfingerprint",
    },
    "github": {
        "actionfingerprint",
        "attemptid",
        "basesha",
        "checksnapshotfingerprint",
        "headsha",
        "mergesha",
        "packagefingerprint",
        "prnumber",
        "prurl",
        "resultfingerprint",
    },
    "companion": {"resultfingerprint"},
}

_OUTPUT_KEYS: dict[str, set[str]] = {
    "research": {"answer", "artifactfingerprint", "evidencefingerprint", "sourcecount", "summary"},
    "code": {
        "artifacthashes",
        "commitsha",
        "diffhash",
        "repairrequestid",
        "summary",
        "validationhash",
        "verifiedcommitreceiptfingerprint",
        "workspaceid",
    },
    "linear": {
        "candidatefingerprint",
        "issue",
        "issueid",
        "issueurl",
        "readbackfingerprint",
        "state",
        "summary",
        "workitemfingerprint",
    },
    "github": {
        "basesha",
        "checksnapshotfingerprint",
        "headsha",
        "mergesha",
        "prnumber",
        "prurl",
        "summary",
    },
}

_EVENT_KEYS: dict[str, set[str]] = {
    "job_accepted": {"executionhost"},
    "job_leased": {"coordinatorid", "leaseexpiresat"},
    "job_queued": {"executionhost"},
    "lease_acquired": {"coordinatorid", "leaseexpiresat"},
    "lease_renewed": {"leaseexpiresat"},
    "job_started": {"domain"},
    "job_progress": {"message", "observedsequence", "percent", "raweventtype", "step"},
    "progress": {"message", "observedsequence", "percent", "step"},
    "receipt_committed": {"fingerprint", "receiptid", "status"},
    "job_waiting_obsidian": {"reason"},
    "job_verifying": {"status", "verifierid"},
    "external_receipt_recorded": {"fingerprint", "operation", "provider", "receiptid", "status"},
    "job_completed": {"blockercode", "resultfingerprint", "status"},
    "job_complete": {"resultfingerprint"},
    "job_blocked": {"blockercode", "code", "message", "requiredaction", "resultfingerprint", "status"},
    "job_cancelled": {"reason", "resultfingerprint", "status"},
    "job_failed": {"blockercode", "code", "message", "requiredaction", "resultfingerprint", "status"},
}


class PersistedDataRejected(ValueError):
    pass


def canonical_json(value: Any) -> str:
    return _serialize_canonical(value, "$")


def canonical_fingerprint(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()}"


def _serialize_canonical(value: Any, path: str) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, int):
        if abs(value) > JS_MAX_SAFE_INTEGER:
            raise PersistedDataRejected(f"Unsafe integer at {path}.")
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PersistedDataRejected(f"Non-finite number at {path}.")
        if value.is_integer() and abs(value) > JS_MAX_SAFE_INTEGER:
            raise PersistedDataRejected(f"Unsafe integer at {path}.")
        return _javascript_number(value)
    if isinstance(value, list):
        return "[" + ",".join(
            _serialize_canonical(entry, f"{path}[{index}]")
            for index, entry in enumerate(value)
        ) + "]"
    if isinstance(value, dict):
        entries: list[str] = []
        keys = list(value)
        if any(not isinstance(key, str) for key in keys):
            raise PersistedDataRejected(f"Non-string key at {path}.")
        # JavaScript Array.prototype.sort compares UTF-16 code units. Python's
        # native string order compares Unicode code points, which differs for
        # supplementary-plane characters versus BMP characters such as U+E000.
        for key in sorted(keys, key=_utf16_sort_key):
            encoded_key = _json_string(key)
            entries.append(
                f"{encoded_key}:{_serialize_canonical(value[key], f'{path}.{key}')}"
            )
        return "{" + ",".join(entries) + "}"
    raise PersistedDataRejected(f"Unsupported canonical value at {path}: {type(value).__name__}.")


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def _json_string(value: str) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    # Match well-formed JSON.stringify for isolated UTF-16 surrogates while
    # keeping ordinary Unicode unescaped.
    return "".join(
        f"\\u{ord(character):04x}"
        if 0xD800 <= ord(character) <= 0xDFFF
        else character
        for character in encoded
    )


def _javascript_number(value: float) -> str:
    if value == 0:
        return "0"
    if value.is_integer():
        return str(int(value))
    absolute = abs(value)
    representation = repr(value).lower()
    if 1e-6 <= absolute < 1e21 and "e" in representation:
        return format(Decimal(representation), "f").rstrip("0").rstrip(".")
    if "e" in representation:
        mantissa, exponent = representation.split("e", 1)
        sign = ""
        if exponent.startswith(("+", "-")):
            sign, exponent = exponent[0], exponent[1:]
        exponent = exponent.lstrip("0") or "0"
        return f"{mantissa}e{sign}{exponent}"
    return representation


def require_fingerprint(value: str, field: str = "fingerprint") -> str:
    if not FINGERPRINT_PATTERN.fullmatch(value):
        raise PersistedDataRejected(f"{field} must be canonical sha256:<64 lowercase hex>.")
    return value


def validate_persisted_text(value: str, field: str) -> str:
    _reject_secret_text(value, field)
    return value


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def validate_job_inputs(domain: str, value: dict[str, Any]) -> dict[str, Any]:
    allowed = _INPUT_KEYS.get(domain)
    if allowed is None:
        raise PersistedDataRejected(f"Unsupported companion domain: {domain}")
    result: dict[str, Any] = {}
    for key, nested in value.items():
        normalized = normalize_key(key)
        if normalized not in allowed:
            raise PersistedDataRejected(f"Input field {key!r} is not allowed for {domain} jobs.")
        if normalized in {"sourceurls", "urls"}:
            candidates = nested if isinstance(nested, list) else [nested]
            if not candidates or any(
                not isinstance(entry, str)
                or not re.match(r"^https?://[^\s]+$", entry, flags=re.I)
                for entry in candidates
            ):
                raise PersistedDataRejected(f"{key} accepts only explicit HTTP(S) URLs.")
            result[key] = _json_value(
                nested,
                f"$.inputs.{key}",
                reject_commands=True,
                enforce_sensitive_keys=True,
            )
            continue
        if normalized in {"baseref", "headref"}:
            if (
                not isinstance(nested, str)
                or len(nested) > 256
                or nested.startswith(("/", "-"))
                or "\\" in nested
                or ".." in nested.split("/")
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", nested)
            ):
                raise PersistedDataRejected(f"{key} must be a bounded logical Git ref.")
            result[key] = nested
            continue
        result[key] = _json_value(
            nested,
            f"$.inputs.{key}",
            reject_paths=True,
            reject_commands=True,
            enforce_sensitive_keys=True,
        )
    return result


def validate_binding(domain: str, value: dict[str, Any]) -> dict[str, Any]:
    if set(value) != {"id", "kind", "destinationFingerprint"}:
        raise PersistedDataRejected("Logical binding references have an exact closed shape.")
    binding_id = value["id"]
    kind = value["kind"]
    if not isinstance(binding_id, str) or not STABLE_ID_PATTERN.fullmatch(binding_id):
        raise PersistedDataRejected("Binding ids must be logical stable ids, never paths.")
    if kind not in _BINDING_KINDS.get(domain, set()):
        raise PersistedDataRejected(f"Binding kind {kind!r} is not allowed for {domain} jobs.")
    require_fingerprint(value["destinationFingerprint"], "destinationFingerprint")
    return dict(value)


def sanitize_event_payload(event_type: str, value: dict[str, Any]) -> dict[str, Any]:
    allowed = _EVENT_KEYS.get(event_type)
    if allowed is None:
        raise PersistedDataRejected(f"Unsupported persisted event type: {event_type}")
    return _closed_payload(value, allowed, f"event {event_type}")


def sanitize_completion_output(domain: str, value: dict[str, Any]) -> dict[str, Any]:
    allowed_top = {"blocker", "evidence", "outputs", "receiptids", "resultfingerprint", "status"}
    for key in value:
        if normalize_key(key) not in allowed_top:
            raise PersistedDataRejected(f"Field {key!r} is not allowed in persisted completion data.")
    result: dict[str, Any] = {}
    if "status" in value:
        if value["status"] not in {"complete", "blocked", "cancelled", "failed"}:
            raise PersistedDataRejected("Completion status is invalid.")
        result["status"] = value["status"]
    if "outputs" in value:
        outputs = value["outputs"]
        if not isinstance(outputs, dict):
            raise PersistedDataRejected("completion output.outputs must be an object.")
        allowed_outputs = _OUTPUT_KEYS.get(domain, set())
        for key in outputs:
            normalized_key = normalize_key(key)
            if normalized_key in _SECRET_REFERENCE_KEYS or any(
                marker in normalized_key for marker in _SECRET_MARKERS
            ):
                raise PersistedDataRejected(
                    f"Plaintext credential field {key!r} cannot be persisted."
                )
            if normalized_key not in allowed_outputs:
                raise PersistedDataRejected(
                    f"Field {key!r} is not allowed in persisted {domain} outputs."
                )
        result["outputs"] = {
            key: _json_value(
                nested,
                f"$.outputs.{key}",
                reject_paths=normalize_key(key) not in {"answer", "summary"},
                reject_commands=True,
                enforce_sensitive_keys=True,
            )
            for key, nested in outputs.items()
        }
    if "evidence" in value:
        evidence = value["evidence"]
        if not isinstance(evidence, list) or len(evidence) > 100:
            raise PersistedDataRejected("Completion evidence must be a bounded list.")
        result["evidence"] = [
            _sanitize_evidence(domain, entry, index)
            for index, entry in enumerate(evidence)
        ]
    if "receiptIds" in value:
        receipt_ids = value["receiptIds"]
        if (
            not isinstance(receipt_ids, list)
            or len(receipt_ids) > 100
            or any(not isinstance(item, str) or not STABLE_ID_PATTERN.fullmatch(item) for item in receipt_ids)
        ):
            raise PersistedDataRejected("Completion receiptIds must be logical stable ids.")
        result["receiptIds"] = list(receipt_ids)
    if "blocker" in value:
        blocker = value["blocker"]
        if blocker is None:
            result["blocker"] = None
        elif not isinstance(blocker, dict):
            raise PersistedDataRejected("completion output.blocker must be an object.")
        else:
            result["blocker"] = _closed_payload(
                blocker, {"code", "message", "requiredaction"}, "blocker"
            )
    if "resultFingerprint" in value:
        require_fingerprint(str(value["resultFingerprint"]), "resultFingerprint")
        result["resultFingerprint"] = value["resultFingerprint"]
    return result


def sanitize_receipt_payload(domain: str, value: dict[str, Any]) -> dict[str, Any]:
    allowed = _RECEIPT_KEYS.get(domain)
    if allowed is None:
        raise PersistedDataRejected(f"Unsupported receipt domain: {domain}")
    return _closed_payload(value, allowed, f"{domain} receipt")


def _closed_payload(value: dict[str, Any], allowed: set[str], context: str) -> dict[str, Any]:
    for key in value:
        if normalize_key(key) not in allowed:
            raise PersistedDataRejected(f"Field {key!r} is not allowed in persisted {context} data.")
    return _json_value(
        value,
        f"$.{context}",
        reject_paths=True,
        reject_commands=True,
        enforce_sensitive_keys=True,
    )


def _sanitize_evidence(domain: str, value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PersistedDataRejected("Completion evidence entries must be objects.")
    allowed_kinds = {
        "research": {"public_web_source", "research_artifact"},
        "code": {"code_validation", "code_artifact"},
        "linear": {"linear_issue_readback", "linear_readback"},
        "github": {"github_readback"},
    }.get(domain, set())
    if set(value) - {
        "kind",
        "url",
        "id",
        "issueId",
        "fingerprint",
        "readbackFingerprint",
        "status",
    }:
        raise PersistedDataRejected("Completion evidence has an unknown field.")
    if value.get("kind") not in allowed_kinds:
        raise PersistedDataRejected(f"Evidence kind is not allowed for {domain}.")
    if "fingerprint" not in value and "readbackFingerprint" not in value:
        raise PersistedDataRejected("Completion evidence requires a fingerprint.")
    fingerprint_value = value.get("fingerprint", value.get("readbackFingerprint"))
    require_fingerprint(str(fingerprint_value), f"evidence[{index}].fingerprint")
    if "url" in value and (
        not isinstance(value["url"], str)
        or not re.match(r"^https?://[^\s]+$", value["url"], flags=re.I)
    ):
        raise PersistedDataRejected("Evidence URLs must be explicit HTTP(S) URLs.")
    if "id" in value and (
        not isinstance(value["id"], str) or not STABLE_ID_PATTERN.fullmatch(value["id"])
    ):
        raise PersistedDataRejected("Evidence ids must be logical stable ids.")
    return _json_value(
        value,
        f"$.evidence[{index}]",
        reject_paths=False,
        reject_commands=True,
        enforce_sensitive_keys=True,
    )


def _json_value(
    value: Any,
    path: str,
    *,
    reject_paths: bool = False,
    reject_commands: bool = False,
    enforce_sensitive_keys: bool = False,
) -> Any:
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str) and reject_paths:
            _reject_path_like(value, path)
        if isinstance(value, str) and reject_commands:
            _reject_command_like(value, path)
        if isinstance(value, str) and enforce_sensitive_keys:
            _reject_secret_text(value, path)
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PersistedDataRejected(f"Non-finite number at {path}.")
        return value
    if isinstance(value, list):
        if len(value) > 500:
            raise PersistedDataRejected(f"Too many entries at {path}.")
        return [
            _json_value(
                entry,
                f"{path}[{index}]",
                reject_paths=reject_paths,
                reject_commands=reject_commands,
                enforce_sensitive_keys=enforce_sensitive_keys,
            )
            for index, entry in enumerate(value)
        ]
    if isinstance(value, dict):
        if len(value) > 200:
            raise PersistedDataRejected(f"Too many fields at {path}.")
        result: dict[str, Any] = {}
        for raw_key, nested in value.items():
            if not isinstance(raw_key, str) or not raw_key or len(raw_key) > 128:
                raise PersistedDataRejected(f"Invalid field name at {path}.")
            key = normalize_key(raw_key)
            if enforce_sensitive_keys and key in _SECRET_REFERENCE_KEYS:
                if not isinstance(nested, str) or not OPAQUE_REFERENCE_PATTERN.fullmatch(nested):
                    raise PersistedDataRejected(
                        f"{raw_key} must be an opaque secretRef or credentialRef."
                    )
            elif enforce_sensitive_keys and any(marker in key for marker in _SECRET_MARKERS):
                # This catches mixed/camel case variants such as githubToken.
                raise PersistedDataRejected(
                    f"Plaintext credential field {raw_key!r} cannot be persisted."
                )
            if reject_commands and key in _COMMAND_KEYS:
                raise PersistedDataRejected(f"Raw command field {raw_key!r} cannot be persisted.")
            if any(marker in key for marker in _VAULT_MARKERS):
                raise PersistedDataRejected(f"Vault field {raw_key!r} cannot be persisted.")
            result[raw_key] = _json_value(
                nested,
                f"{path}.{raw_key}",
                reject_paths=reject_paths,
                reject_commands=reject_commands,
                enforce_sensitive_keys=enforce_sensitive_keys,
            )
        return result
    raise PersistedDataRejected(f"Unsupported persisted value at {path}: {type(value).__name__}.")


def _reject_path_like(value: str, path: str) -> None:
    normalized = value.strip()
    lowered = normalized.replace("\\", "/").lower()
    relative_path = bool(
        re.search(
            r"(?:^|\s)(?:\.{1,2}/|~/|[A-Za-z][A-Za-z0-9_.-]*/[A-Za-z][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_.-]+)*)",
            normalized,
        )
    )
    if (
        normalized.startswith("/")
        or _ABSOLUTE_WINDOWS.match(normalized)
        or _UNC_PATH.match(normalized)
        or "\\" in normalized
        or relative_path
        or lowered == ".."
        or lowered.startswith("../")
        or "/../" in lowered
        or any(marker in lowered for marker in _VAULT_MARKERS)
        or bool(
            re.search(
                r"(?:^|\s)[A-Za-z0-9_.-]+\.(?:md|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c|h)(?:$|\s)",
                normalized,
                flags=re.I,
            )
        )
    ):
        raise PersistedDataRejected(f"Raw absolute or vault path cannot be persisted at {path}.")


def _reject_command_like(value: str, path: str) -> None:
    normalized = value.strip()
    if re.match(
        r"^(?:npm|npx|pnpm|yarn|python(?:3)?|pip|cargo|go|mvn|gradle|dotnet|git|bash|sh|zsh|pwsh|powershell|cmd(?:\.exe)?)\s+",
        normalized,
        flags=re.I,
    ) or any(marker in normalized for marker in ("&&", "||", "$(`", "$(", "`")):
        raise PersistedDataRejected(f"Raw command text cannot be persisted at {path}.")


def _reject_secret_text(value: str, path: str) -> None:
    if re.search(
        r"(?:Bearer\s+[A-Za-z0-9._~+/-]{8,}|(?:github[_-]?token|api[_-]?key|password|client[_-]?secret)\s*[=:]\s*\S+|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,})",
        value,
        flags=re.I,
    ):
        raise PersistedDataRejected(f"Plaintext credential material cannot be persisted at {path}.")
