import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Enforces the theme-adaptive contract for the mission console in styles.css.
//
// Every color in the console must resolve to an Obsidian CSS variable (directly
// or through a color-mix over one of the --agent-* tokens), and box dimensions
// must scale with type. This checker fails the build if a hardcoded color or
// fixed px height sneaks back in, so the green-on-black terminal palette cannot
// be reintroduced by accident.
//
// Region boundaries live in styles.css as marker comments rather than as line
// numbers here. Line numbers drift silently every time the stylesheet is
// restructured — and a drifted boundary makes this checker stop policing
// without ever failing. A marker moves in the same diff as the rules it bounds.
//
// See AGENTS.md "Product Direction" for the governing directive.

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = join(__dirname, "..", "styles.css");

// Lines up to the token-block-end marker define the --agent-* palette in terms
// of Obsidian variables and color-mix(). Literal hex is permitted only here, and
// only inside color-mix()/var() fallbacks.
const TOKEN_BLOCK_END_MARKER = "@style-tokens:token-block-end";

// The settings tab (already theme-correct) occupies the region up to this
// marker. Fixed px min/max-height is tolerated there because it predates the
// console restyle; only the console region below is policed.
const SETTINGS_REGION_END_MARKER = "@style-tokens:settings-region-end";

const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/u;
const RGBA_PATTERN = /\brgba?\(/u;
const FIXED_BLOCK_HEIGHT_PATTERN = /\b(?:min|max)-height:\s*[^;]*\b\d+px/u;

function stripComments(source) {
  // Blank out /* ... */ comments while preserving line count, so reported line
  // numbers stay accurate and commented-out samples do not trip the checker.
  return source.replace(/\/\*[\s\S]*?\*\//gu, (match) =>
    match.replace(/[^\n]/gu, " "),
  );
}

// Marker lookup runs against the raw source: stripComments() blanks the very
// comments that carry the markers, so resolving them afterwards would find
// nothing and silently collapse both regions to zero.
function findMarkerLine(rawLines, marker) {
  const index = rawLines.findIndex((line) => line.includes(marker));
  if (index === -1) {
    throw new Error(
      `styles.css is missing the '${marker}' marker comment. ` +
        `Region boundaries are defined by these markers — restore it (as '/* ${marker} */') ` +
        `rather than removing it, or this check stops policing that region.`,
    );
  }
  return index + 1;
}

async function main() {
  const raw = await readFile(STYLES_PATH, "utf8");
  const rawLines = raw.split(/\r?\n/u);

  const tokenBlockEnd = findMarkerLine(rawLines, TOKEN_BLOCK_END_MARKER);
  const settingsRegionEnd = findMarkerLine(rawLines, SETTINGS_REGION_END_MARKER);

  if (settingsRegionEnd <= tokenBlockEnd) {
    throw new Error(
      `styles.css markers are out of order: '${SETTINGS_REGION_END_MARKER}' (line ${settingsRegionEnd}) ` +
        `must come after '${TOKEN_BLOCK_END_MARKER}' (line ${tokenBlockEnd}).`,
    );
  }

  const lines = stripComments(raw).split(/\r?\n/u);
  const violations = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const inTokenBlock = lineNumber <= tokenBlockEnd;
    const inConsoleRegion = lineNumber > settingsRegionEnd;

    if (RGBA_PATTERN.test(line)) {
      violations.push({
        lineNumber,
        rule: "rgba",
        message:
          "rgba()/rgb() literal — use an --agent-* token or color-mix() over var(--text-accent).",
        line: line.trim(),
      });
    }

    if (!inTokenBlock && HEX_PATTERN.test(line)) {
      violations.push({
        lineNumber,
        rule: "hex",
        message:
          "hardcoded hex color outside the token block — reference an --agent-* token or Obsidian variable.",
        line: line.trim(),
      });
    }

    if (inConsoleRegion && FIXED_BLOCK_HEIGHT_PATTERN.test(line)) {
      violations.push({
        lineNumber,
        rule: "fixed-height",
        message:
          "fixed px min/max-height in the console region — use em / min(..) so it scales with the theme font.",
        line: line.trim(),
      });
    }
  });

  if (violations.length > 0) {
    console.error(
      `styles.css style-token check failed with ${violations.length} violation(s):`,
    );
    for (const violation of violations) {
      console.error(
        `- styles.css:${violation.lineNumber} [${violation.rule}] ${violation.message}`,
      );
      console.error(`    ${violation.line}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `styles.css style-token check passed; console palette is fully tokenized ` +
      `(token block ends line ${tokenBlockEnd}, settings region ends line ${settingsRegionEnd}).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
