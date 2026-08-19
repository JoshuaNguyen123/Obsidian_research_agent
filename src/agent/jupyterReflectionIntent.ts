const NOTEBOOK_PATH_PATTERN =
  String.raw`[A-Za-z0-9@()[\]_.-]+(?:\/[A-Za-z0-9 @()[\]_.-]+)*\.ipynb`;

/**
 * Extract safe vault-relative notebook paths named literally by the user.
 * Paths containing spaces must be quoted; this keeps an unquoted sentence
 * from being mistaken for destination authority.
 */
export function extractExplicitJupyterNotebookPathsV1(
  prompt: string,
): string[] {
  const candidates = [
    ...[...prompt.matchAll(/["'`]([^"'`\r\n]+\.ipynb)["'`]/giu)].map(
      (match) => match[1] ?? "",
    ),
    ...[
      ...prompt.matchAll(
        new RegExp(
          String.raw`(?:^|[\s(])(${NOTEBOOK_PATH_PATTERN})(?=$|[\s),.;:])`,
          "giu",
        ),
      ),
    ].map((match) => match[1] ?? ""),
  ];
  return [
    ...new Set(
      candidates
        .map((value) => value.trim())
        .filter(isSafeVaultJupyterNotebookPathV1),
    ),
  ];
}

export function isSafeVaultJupyterNotebookPathV1(value: string): boolean {
  const parts = value.split("/");
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    value === value.trim() &&
    value.toLowerCase().endsWith(".ipynb") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[a-z]:/iu.test(value) &&
    !/[\0\r\n?#]/u.test(value) &&
    !parts.some(
      (part) => !part || part === "." || part === ".." || part.startsWith("."),
    )
  );
}

/**
 * True for an affirmative reflection write to Jupyter. An exact `.ipynb`
 * path remains the strongest destination signal, but natural requests such as
 * "write the final reflection to a Jupyter notebook" intentionally authorize
 * the host to derive a safe no-overwrite Results path.
 */
export function hasJupyterReflectionIntentV1(prompt: string): boolean {
  if (hasJupyterReflectionNegationV1(prompt)) return false;
  const clauses = prompt
    .replace(/\r\n?/gu, "\n")
    .split(/(?:[!?;\n]+|\.(?=\s|$)|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some((clause) => {
    const notebookPaths = extractExplicitJupyterNotebookPathsV1(clause);
    const hasNotebookTarget =
      notebookPaths.length > 0 ||
      /\b(?:jupyter(?:\s+notebook)?|notebook)\b/iu.test(clause);
    if (!hasNotebookTarget) return false;
    const intentText = notebookPaths.reduce(
      (text, path) => text.split(path).join(" "),
      clause,
    );
    return (
      /\b(?:append_jupyter_reflection|append|create|produce|record|reflect|reflecting|summari[sz]e|write[ -]?back)\b/iu.test(
          intentText,
        ) ||
        /\bwrite\b[^.\n]{0,80}\b(?:final\s+)?(?:reflection|retrospective|report|results?|summary)\b/iu.test(
          intentText,
        ) ||
        /\b(?:want|need|prefer)\b[^.\n]{0,100}\b(?:reflection|retrospective|report|results?|summary)\b/iu.test(
          intentText,
        )
    );
  });
}

/** A write/destination opt-out wins over any positive phrase elsewhere. */
function hasJupyterReflectionNegationV1(prompt: string): boolean {
  const text = prompt.replace(/\r\n?/gu, "\n");
  const target = String.raw`(?:jupyter(?:\s+notebook)?|notebook|[^.!?;\n]{0,100}\.ipynb\b)`;
  const writeAction =
    String.raw`(?:call\s+append_jupyter_reflection|append|create|produce|record|reflect\w*|summari[sz]e|write(?:[ -]?back)?)`;
  return (
    new RegExp(
      String.raw`\b(?:do\s+not|don't|never|skip)\b[^.!?;\n]{0,100}\b${writeAction}\b[^.!?;\n]{0,120}\b${target}`,
      "iu",
    ).test(text) ||
    new RegExp(
      String.raw`\b(?:do\s+not|don't|never|skip)\b[^.!?;\n]{0,100}\b(?:use|choose|select)\b[^.!?;\n]{0,100}\b${target}`,
      "iu",
    ).test(text) ||
    new RegExp(
      String.raw`\b(?:write|record|append|put|save)\b[^.!?;\n]{0,140}\b(?:not\s+(?:in|to|as)|rather\s+than)\b[^.!?;\n]{0,60}\b${target}`,
      "iu",
    ).test(text) ||
    /\b(?:leave|keep)\b[^.!?;\n]{0,140}(?:\.ipynb\b|\bjupyter\b|\bnotebook\b)[^.!?;\n]{0,80}\bunchanged\b/iu.test(
      text,
    ) ||
    /\bwithout\b[^.!?;\n]{0,60}\b(?:writing?|appending?|creating?|recording?|reflecting?)\b/iu.test(
      text,
    ) ||
    /\bwithout\b[^.!?;\n]{0,60}\b(?:jupyter(?:\s+notebook)?|notebook)\b/iu.test(
      text,
    )
  );
}
