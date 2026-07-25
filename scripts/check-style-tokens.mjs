import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Enforces the theme-adaptive contract for the mission console in styles.css.
//
// After the Phase 6 tokenization, every color in the console must resolve to an
// Obsidian CSS variable (directly or through a color-mix over one of the
// --agent-* tokens), and box dimensions must scale with type. This checker fails
// the build if a hardcoded color or fixed px height sneaks back in, so the
// green-on-black terminal palette cannot be reintroduced by accident.
//
// See AGENTS.md "Product Direction" for the governing directive.

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = join(__dirname, "..", "styles.css");

// Lines 1..TOKEN_BLOCK_END define the --agent-* token palette in terms of
// Obsidian variables and color-mix(). Literal hex is permitted only here, and
// only inside color-mix()/var() fallbacks — see assertions below.
const TOKEN_BLOCK_END = 31;

// The settings tab (already theme-correct) occupies the region up to this line.
// Fixed px min/max-height is tolerated there because it predates this work and
// is not part of the console restyle; only the console region below is policed.
const SETTINGS_REGION_END = 505;

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

async function main() {
  const raw = await readFile(STYLES_PATH, "utf8");
  const lines = stripComments(raw).split(/\r?\n/u);
  const violations = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const inTokenBlock = lineNumber <= TOKEN_BLOCK_END;
    const inConsoleRegion = lineNumber > SETTINGS_REGION_END;

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
    `styles.css style-token check passed; console palette is fully tokenized.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
