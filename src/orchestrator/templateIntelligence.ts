export type TemplateFieldType =
  | "string"
  | "markdown"
  | "number"
  | "boolean"
  | "date";

export interface TemplateFieldDefinition {
  name: string;
  label?: string;
  type?: TemplateFieldType;
  required?: boolean;
  defaultValue?: string | number | boolean;
  description?: string;
  group?: string;
}

export interface TemplateMetadata {
  kind?: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  fields?: TemplateFieldDefinition[];
}

export interface TemplateDocument {
  path: string;
  content: string;
  metadata?: TemplateMetadata;
  modifiedAt?: string;
}

export interface TemplateCandidate extends TemplateDocument {
  id: string;
  title: string;
  placeholders: string[];
  fields: TemplateFieldDefinition[];
}

export interface RankedTemplateCandidate extends TemplateCandidate {
  score: number;
  reasons: string[];
}

export interface MissingTemplateFieldGroup {
  group: string;
  fields: TemplateFieldDefinition[];
}

export interface TemplateDryRenderResult {
  content: string;
  resolvedValues: Record<string, string>;
  unresolvedPlaceholders: string[];
  missingFieldGroups: MissingTemplateFieldGroup[];
  canCreate: boolean;
}

export interface TemplateVerificationResult {
  passed: boolean;
  contentMatches: boolean;
  unresolvedPlaceholders: string[];
  expectedBytes: number;
  actualBytes: number;
  reasons: string[];
}

export const SAFE_TEMPLATE_BUILTINS = [
  "date",
  "time",
  "datetime",
  "year",
  "title",
  "slug",
  "frontmatter_title",
] as const;

export type SafeTemplateBuiltin = (typeof SAFE_TEMPLATE_BUILTINS)[number];

const BUILTIN_SET = new Set<string>(SAFE_TEMPLATE_BUILTINS);
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]{0,79})\s*\}\}/g;

export function discoverAndRankTemplates(
  documents: TemplateDocument[],
  request: {
    query: string;
    kind?: string;
    tags?: string[];
    availableValues?: Record<string, unknown>;
  },
): RankedTemplateCandidate[] {
  const queryTokens = tokenize(request.query);
  const requestedTags = new Set((request.tags ?? []).map(normalizeToken).filter(Boolean));
  const requestedKind = normalizeToken(request.kind ?? "");

  return documents
    .filter((document) => isSafeMarkdownPath(document.path) && document.content.trim())
    .map(analyzeTemplateDocument)
    .map((candidate) => {
      const reasons: string[] = [];
      const metadata = candidate.metadata ?? {};
      const searchable = tokenize(
        [
          candidate.title,
          candidate.path,
          metadata.kind ?? "",
          metadata.description ?? "",
          ...(metadata.tags ?? []),
          ...(metadata.aliases ?? []),
        ].join(" "),
      );
      const searchableSet = new Set(searchable);
      const tokenMatches = queryTokens.filter((token) => searchableSet.has(token)).length;
      let score = queryTokens.length > 0 ? (tokenMatches / queryTokens.length) * 55 : 0;
      if (tokenMatches > 0) reasons.push(`${tokenMatches} query term match${tokenMatches === 1 ? "" : "es"}`);

      if (requestedKind && normalizeToken(metadata.kind ?? "") === requestedKind) {
        score += 25;
        reasons.push("template kind match");
      }
      const candidateTags = new Set((metadata.tags ?? []).map(normalizeToken).filter(Boolean));
      const tagMatches = [...requestedTags].filter((tag) => candidateTags.has(tag)).length;
      if (tagMatches > 0) {
        score += Math.min(15, tagMatches * 5);
        reasons.push(`${tagMatches} tag match${tagMatches === 1 ? "" : "es"}`);
      }

      const missingRequired = groupMissingTemplateFields(
        candidate.fields,
        request.availableValues ?? {},
      ).reduce((count, group) => count + group.fields.length, 0);
      if (missingRequired === 0) {
        score += 5;
        reasons.push("all required fields available");
      } else {
        score -= Math.min(15, missingRequired * 3);
        reasons.push(`${missingRequired} required field${missingRequired === 1 ? "" : "s"} unresolved`);
      }
      return {
        ...candidate,
        score: Math.round(Math.max(0, Math.min(100, score)) * 100) / 100,
        reasons,
      };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

export function analyzeTemplateDocument(
  document: TemplateDocument,
): TemplateCandidate {
  const placeholders = extractTemplatePlaceholders(document.content);
  const declaredFields = normalizeFieldDefinitions(document.metadata?.fields ?? []);
  const declaredByName = new Map(declaredFields.map((field) => [field.name, field]));
  const fields = placeholders
    .filter((name) => !BUILTIN_SET.has(name))
    .map(
      (name): TemplateFieldDefinition =>
        declaredByName.get(name) ?? {
          name,
          label: humanizeFieldName(name),
          type: "string",
          required: true,
          group: "Required",
        },
    );
  for (const field of declaredFields) {
    if (!fields.some((existing) => existing.name === field.name) && !BUILTIN_SET.has(field.name)) {
      fields.push(field);
    }
  }
  const title = basenameWithoutExtension(document.path);
  return {
    ...document,
    id: stableTemplateId(document.path),
    title,
    placeholders,
    fields,
  };
}

export function extractTemplatePlaceholders(content: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

export function resolveSafeTemplateBuiltins(input: {
  title?: string;
  now?: Date;
}): Record<SafeTemplateBuiltin, string> {
  const now = input.now ?? new Date();
  const safeTitle = sanitizeSingleLine(input.title ?? "Untitled", 180) || "Untitled";
  const date = formatLocalDate(now);
  const time = formatLocalTime(now);
  return {
    date,
    time,
    datetime: `${date}T${time}`,
    year: String(now.getFullYear()),
    title: safeTitle,
    slug: slugify(safeTitle),
    frontmatter_title: JSON.stringify(safeTitle),
  };
}

export function groupMissingTemplateFields(
  fields: TemplateFieldDefinition[],
  values: Record<string, unknown>,
): MissingTemplateFieldGroup[] {
  const groups = new Map<string, TemplateFieldDefinition[]>();
  for (const field of normalizeFieldDefinitions(fields)) {
    if (field.required === false || field.defaultValue !== undefined) continue;
    if (hasTemplateValue(values[field.name])) continue;
    const group = field.group?.trim() || "Required";
    const existing = groups.get(group) ?? [];
    existing.push(field);
    groups.set(group, existing);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupedFields]) => ({
      group,
      fields: groupedFields.sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

export function dryRenderTemplate(
  template: Pick<TemplateCandidate, "content" | "fields">,
  input: {
    values?: Record<string, unknown>;
    title?: string;
    now?: Date;
  },
): TemplateDryRenderResult {
  const values = input.values ?? {};
  const builtins = resolveSafeTemplateBuiltins({ title: input.title, now: input.now });
  const fields = normalizeFieldDefinitions(template.fields);
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const resolvedValues: Record<string, string> = { ...builtins };

  for (const field of fields) {
    const raw = hasTemplateValue(values[field.name])
      ? values[field.name]
      : field.defaultValue;
    if (hasTemplateValue(raw)) {
      resolvedValues[field.name] = serializeTemplateValue(raw, field.type ?? "string");
    } else if (field.required === false) {
      resolvedValues[field.name] = "";
    }
  }

  const content = template.content.replace(
    PLACEHOLDER_PATTERN,
    (original, name: string) =>
      Object.prototype.hasOwnProperty.call(resolvedValues, name)
        ? resolvedValues[name]
        : original,
  );
  const unresolvedPlaceholders = extractTemplatePlaceholders(content);
  const missingFieldGroups = groupMissingTemplateFields(fields, {
    ...values,
    ...resolvedValues,
  });
  const blockingUnresolved = unresolvedPlaceholders.filter((name) => {
    if (BUILTIN_SET.has(name)) return true;
    return fieldByName.get(name)?.required !== false;
  });
  return {
    content,
    resolvedValues,
    unresolvedPlaceholders,
    missingFieldGroups,
    canCreate: missingFieldGroups.length === 0 && blockingUnresolved.length === 0,
  };
}

export function suggestCollisionFreeTemplatePath(
  desiredPath: string,
  existingPaths: Iterable<string>,
  maxAttempts = 100,
): string {
  const normalized = normalizeMarkdownPath(desiredPath);
  const existing = new Set([...existingPaths].map((path) => normalizeMarkdownPath(path).toLowerCase()));
  if (!existing.has(normalized.toLowerCase())) return normalized;
  const extensionIndex = normalized.toLowerCase().endsWith(".md")
    ? normalized.length - 3
    : normalized.length;
  const stem = normalized.slice(0, extensionIndex);
  const extension = normalized.slice(extensionIndex) || ".md";
  const limit = Math.max(2, Math.min(10_000, Math.trunc(maxAttempts)));
  for (let suffix = 2; suffix <= limit; suffix += 1) {
    const candidate = `${stem} ${suffix}${extension}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Could not find a collision-free path for ${normalized}.`);
}

export function verifyRenderedTemplate(
  expectedContent: string,
  actualContent: string,
): TemplateVerificationResult {
  const expected = normalizeNewlines(expectedContent);
  const actual = normalizeNewlines(actualContent);
  const unresolvedPlaceholders = extractTemplatePlaceholders(actual);
  const contentMatches = expected === actual;
  const reasons: string[] = [];
  if (!contentMatches) reasons.push("Read-back content does not match the approved preview.");
  if (unresolvedPlaceholders.length > 0) {
    reasons.push(`Unresolved placeholders: ${unresolvedPlaceholders.join(", ")}.`);
  }
  return {
    passed: contentMatches && unresolvedPlaceholders.length === 0,
    contentMatches,
    unresolvedPlaceholders,
    expectedBytes: Buffer.byteLength(expectedContent, "utf8"),
    actualBytes: Buffer.byteLength(actualContent, "utf8"),
    reasons,
  };
}

function normalizeFieldDefinitions(
  fields: TemplateFieldDefinition[],
): TemplateFieldDefinition[] {
  const result: TemplateFieldDefinition[] = [];
  const seen = new Set<string>();
  for (const input of fields) {
    const name = input.name?.trim();
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      label: sanitizeSingleLine(input.label ?? humanizeFieldName(name), 120),
      type: isTemplateFieldType(input.type) ? input.type : "string",
      required: input.required !== false,
      defaultValue: input.defaultValue,
      description: input.description
        ? sanitizeSingleLine(input.description, 500)
        : undefined,
      group: sanitizeSingleLine(input.group ?? (input.required === false ? "Optional" : "Required"), 80),
    });
  }
  return result;
}

function serializeTemplateValue(value: unknown, type: TemplateFieldType): string {
  if (type === "boolean") {
    return value === true || String(value).toLowerCase() === "true" ? "true" : "false";
  }
  if (type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`Template value ${String(value)} is not a finite number.`);
    return String(number);
  }
  if (type === "date") {
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new Error(`Template date value ${text} must use YYYY-MM-DD.`);
    }
    return text;
  }
  const text = String(value);
  return type === "markdown" ? text : sanitizeSingleLine(text, 4_000);
}

function hasTemplateValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

function normalizeMarkdownPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.includes("..") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Template output path must be a safe vault-relative markdown path.");
  }
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function isSafeMarkdownPath(path: string): boolean {
  try {
    normalizeMarkdownPath(path);
    return path.toLowerCase().endsWith(".md");
  } catch {
    return false;
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function sanitizeSingleLine(value: string, maxLength: number): string {
  return value.replace(/[\r\n\0]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function basenameWithoutExtension(path: string): string {
  const basename = path.replace(/\\/g, "/").split("/").pop() ?? "Template";
  return basename.replace(/\.md$/i, "") || "Template";
}

function humanizeFieldName(name: string): string {
  const value = name.replace(/[_.-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : name;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map(normalizeToken)
        .filter((token) => token.length > 1),
    ),
  );
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function stableTemplateId(path: string): string {
  let hash = 2166136261;
  for (const character of normalizeMarkdownPath(path).toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `template-${(hash >>> 0).toString(36)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "untitled";
}

function formatLocalDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function formatLocalTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}`;
}

function isTemplateFieldType(value: unknown): value is TemplateFieldType {
  return value === "string" || value === "markdown" || value === "number" || value === "boolean" || value === "date";
}
