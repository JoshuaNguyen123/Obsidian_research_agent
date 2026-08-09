/**
 * Render provider-authored assistant Markdown without Obsidian's global
 * Markdown postprocessor/embed pipeline. Every node is host-created and every
 * provider string reaches the DOM only through textContent.
 */
export function renderSafeAssistantMarkdownV1(
  markdown: string,
  container: HTMLElement,
): void {
  const safe = sanitizeAssistantMarkdownPresentationV1(markdown);
  const lines = safe.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s*```(?:\s*([A-Za-z0-9_-]+))?\s*$/u.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.language = fence[1].toLowerCase();
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1]!.length}`);
      appendSafeInlineMarkdownV1(element, heading[2]!);
      container.appendChild(element);
      index += 1;
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/u.test(line)) {
      container.appendChild(document.createElement("hr"));
      index += 1;
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      while (index < lines.length) {
        const item = unordered
          ? /^\s*[-*+]\s+(.+)$/u.exec(lines[index] ?? "")
          : /^\s*\d+[.)]\s+(.+)$/u.exec(lines[index] ?? "");
        if (!item) break;
        const li = document.createElement("li");
        appendSafeInlineMarkdownV1(li, item[1]!);
        list.appendChild(li);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/u.exec(line);
    if (quote) {
      const blockquote = document.createElement("blockquote");
      const quoted: string[] = [];
      while (index < lines.length) {
        const next = /^\s*>\s?(.*)$/u.exec(lines[index] ?? "");
        if (!next) break;
        quoted.push(next[1] ?? "");
        index += 1;
      }
      appendSafeInlineMarkdownV1(blockquote, quoted.join(" "));
      container.appendChild(blockquote);
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !isBlockStartV1(lines[index] ?? "")
    ) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    const p = document.createElement("p");
    appendSafeInlineMarkdownV1(p, paragraph.join(" "));
    container.appendChild(p);
  }
}

export function sanitizeAssistantMarkdownPresentationV1(markdown: string): string {
  if (typeof markdown !== "string") return "";
  return markdown
    .replace(/!\[\[([^\]]{0,500})\]\]/gu, (_match, label: string) =>
      `[Vault embed blocked: ${compactLabelV1(label)}]`)
    .replace(/!\[([^\]]{0,500})\]\([^\n)]{0,2000}\)/gu, (_match, alt: string) =>
      `[Image blocked: ${compactLabelV1(alt) || "image"}]`)
    .replace(/!\[([^\]]{0,500})\]\[[^\]\n]{0,500}\]/gu, (_match, alt: string) =>
      `[Image blocked: ${compactLabelV1(alt) || "image"}]`)
    .replace(/<!--[\s\S]*?-->/gu, "[HTML comment blocked]")
    .replace(/<\/?[A-Za-z][^>\n]{0,2000}>/gu, "[HTML blocked]");
}

function isBlockStartV1(line: string): boolean {
  return (
    /^\s*```/u.test(line) ||
    /^#{1,6}\s+/u.test(line) ||
    /^\s*[-*+]\s+/u.test(line) ||
    /^\s*\d+[.)]\s+/u.test(line) ||
    /^\s*>/u.test(line) ||
    /^\s*(?:[-*_]\s*){3,}$/u.test(line)
  );
}

function appendSafeInlineMarkdownV1(parent: HTMLElement, value: string): void {
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^\n)]{1,2000}\))/gu;
  let cursor = 0;
  for (const match of value.matchAll(token)) {
    const start = match.index ?? 0;
    if (start > cursor) parent.append(value.slice(cursor, start));
    const raw = match[0];
    if (raw.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = raw.slice(1, -1);
      parent.appendChild(code);
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = raw.slice(2, -2);
      parent.appendChild(strong);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(raw);
      const span = document.createElement("span");
      span.className = "agentic-researcher-safe-link-text";
      span.textContent = link ? `${link[1]} (${link[2]})` : raw;
      parent.appendChild(span);
    }
    cursor = start + raw.length;
  }
  if (cursor < value.length) parent.append(value.slice(cursor));
}

function compactLabelV1(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 160);
}
