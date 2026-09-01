# Constraints and escalation boundaries

Escalate instead of autonomously proceeding when work needs a product decision, destructive operation, large architectural rewrite, uncertain public API compatibility, significant database migration, credentials, production deployment, package publication, billing/cloud mutation, or security-control reduction.

Automatic work must be bounded, reversible, supported by evidence, and within the iteration/failure/value/confidence thresholds in `.agent/quality-gates.yaml` and `.agent/debt/policy.yaml`.
