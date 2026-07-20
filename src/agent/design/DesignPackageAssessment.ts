import type {
  CreateDesignPackageInput,
  DesignItemKind,
  DesignPackageKind,
} from "./DesignPackageTypes";

export interface DesignPackageAssessment {
  version: 1;
  profile: DesignPackageKind;
  coveredConcerns: string[];
  warnings: string[];
}

interface Concern {
  name: string;
  itemKinds?: readonly DesignItemKind[];
  text?: RegExp;
}

const DISTRIBUTED_SYSTEM_CONCERNS: readonly Concern[] = [
  { name: "entry and trust boundary", itemKinds: ["client", "gateway", "external_system", "actor"] },
  { name: "compute and ownership", itemKinds: ["service", "worker", "process"] },
  { name: "state and asynchronous flow", itemKinds: ["database", "cache", "queue", "broker", "event"] },
  {
    name: "capacity and scaling",
    text: /\b(scale|scaling|replicas?|shards?|partitions?|autoscal|capacity|throughput|backpressure|load\s+balanc)/iu,
  },
  {
    name: "resilience and recovery",
    text: /\b(failover|retry|retries|timeout|circuit\s+breaker|disaster|recover|idempoten|redundan|availability|dead[-\s]?letter)/iu,
  },
  {
    name: "security",
    text: /\b(auth|encrypt|zero\s+trust|identity|rbac|secret|security|threat|least\s+privilege|tls)\b/iu,
  },
  {
    name: "observability and service objectives",
    text: /\b(observ|metric|trace|logging|telemetry|alert|slo|service\s+level|health\s+check)/iu,
  },
];

const BUSINESS_PROCESS_CONCERNS: readonly Concern[] = [
  { name: "participants and ownership", itemKinds: ["actor", "persona", "client", "supplier"] },
  { name: "process steps and handoffs", itemKinds: ["process", "subprocess", "operation", "workcell"] },
  { name: "decisions and controls", itemKinds: ["decision", "control", "inspection"] },
  { name: "systems and records", itemKinds: ["service", "database", "document", "external_system"] },
  { name: "performance measures", itemKinds: ["metric"] },
  {
    name: "exceptions and escalation",
    text: /\b(exception|reject|rework|escalat|failure|fallback|timeout|nonconform)/iu,
  },
];

const MANUFACTURING_PROCESS_CONCERNS: readonly Concern[] = [
  { name: "suppliers and material inputs", itemKinds: ["supplier", "material", "inventory"] },
  { name: "transformation and work cells", itemKinds: ["operation", "workcell", "facility", "process", "subprocess"] },
  { name: "quality gates and process control", itemKinds: ["inspection", "control", "metric"] },
  { name: "finished output", itemKinds: ["output"] },
  {
    name: "safety and traceability",
    text: /\b(safety|hazard|lockout|traceab|lot|batch|serial|compliance|ppe)\b/iu,
  },
  {
    name: "flow and operating performance",
    text: /\b(oee|cycle\s+time|takt|throughput|yield|scrap|wip|downtime|bottleneck)\b/iu,
  },
];

export function assessDesignPackage(
  input: CreateDesignPackageInput,
): DesignPackageAssessment {
  const concerns = getConcerns(input.kind);
  if (concerns.length === 0) {
    return {
      version: 1,
      profile: input.kind,
      coveredConcerns: [],
      warnings: [],
    };
  }

  const itemKinds = new Set(input.items.map((item) => item.kind));
  const searchableText = input.items.map((item) => [
    item.title,
    item.summary,
    ...(item.details ?? []),
    ...Object.entries(item.metadata ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => [key, String(value)]),
  ].join(" ")).join("\n");

  const coveredConcerns = concerns
    .filter((concern) => isConcernCovered(concern, itemKinds, searchableText))
    .map((concern) => concern.name);
  const covered = new Set(coveredConcerns);
  const warnings = concerns
    .filter((concern) => !covered.has(concern.name))
    .map((concern) => `Add explicit ${concern.name} evidence before treating this diagram as implementation-ready.`);

  return {
    version: 1,
    profile: input.kind,
    coveredConcerns,
    warnings,
  };
}

function getConcerns(kind: DesignPackageKind): readonly Concern[] {
  if (kind === "distributed_system") return DISTRIBUTED_SYSTEM_CONCERNS;
  if (kind === "business_process") return BUSINESS_PROCESS_CONCERNS;
  if (kind === "manufacturing_process") return MANUFACTURING_PROCESS_CONCERNS;
  return [];
}

function isConcernCovered(
  concern: Concern,
  itemKinds: ReadonlySet<DesignItemKind>,
  searchableText: string,
): boolean {
  return Boolean(
    concern.itemKinds?.some((kind) => itemKinds.has(kind)) ||
      concern.text?.test(searchableText),
  );
}
