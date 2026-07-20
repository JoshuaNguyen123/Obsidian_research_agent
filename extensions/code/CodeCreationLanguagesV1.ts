export const CODE_CREATION_LANGUAGE_CATALOG_V1 = [
  { id: "python", displayName: "Python", extensions: [".py"] },
  { id: "jupyter", displayName: "Jupyter Notebook", extensions: [".ipynb"] },
  { id: "typescript", displayName: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { id: "javascript", displayName: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { id: "c", displayName: "C", extensions: [".c", ".h"] },
  { id: "cpp", displayName: "C++", extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"] },
  { id: "html", displayName: "HTML", extensions: [".html", ".htm"] },
  { id: "css", displayName: "CSS", extensions: [".css"] },
  { id: "rust", displayName: "Rust", extensions: [".rs"] },
  { id: "go", displayName: "Go", extensions: [".go"] },
  { id: "java", displayName: "Java", extensions: [".java"] },
  { id: "csharp", displayName: "C#", extensions: [".cs"] },
] as const;

export type CodeCreationLanguageIdV1 =
  typeof CODE_CREATION_LANGUAGE_CATALOG_V1[number]["id"];

export interface CodeCreationLanguageMatchV1 {
  id: CodeCreationLanguageIdV1;
  displayName: string;
  extension: string;
}

export const CODE_CREATION_LANGUAGE_SUMMARY_V1 =
  "Python, Jupyter notebooks, TypeScript, JavaScript, C, C++, HTML, CSS, Rust, Go, Java, and C#";

/** Classify only the target filename; content remains untrusted text until its prepared write. */
export function detectCodeCreationLanguageV1(
  relativePath: string,
): CodeCreationLanguageMatchV1 | null {
  const filename = relativePath.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const normalized = filename.toLowerCase();
  for (const language of CODE_CREATION_LANGUAGE_CATALOG_V1) {
    const extension = language.extensions.find((candidate) =>
      normalized.endsWith(candidate),
    );
    if (extension) {
      return {
        id: language.id,
        displayName: language.displayName,
        extension,
      };
    }
  }
  return null;
}
