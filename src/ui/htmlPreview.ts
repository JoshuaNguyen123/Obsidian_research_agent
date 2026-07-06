export const HTML_PREVIEW_CLASS = "agentic-researcher-html-preview";
export const HTML_PREVIEW_IFRAME_CLASS = "agentic-researcher-html-preview-frame";
export const HTML_PREVIEW_IFRAME_SANDBOX = "";

export interface HtmlPreviewOptions {
  title?: string;
}

export interface HtmlPreviewRenderResult {
  wrapper: HTMLDivElement;
  iframe: HTMLIFrameElement;
  srcdoc: string;
  sandbox: string;
}

export function buildHtmlPreviewDocument(
  html: string,
  options: HtmlPreviewOptions = {},
): string {
  const title = escapeHtml(options.title?.trim() || "HTML Preview");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data: https: http:; media-src data: https: http:; font-src data: https: http:; style-src &#39;unsafe-inline&#39;; script-src &#39;none&#39;; connect-src &#39;none&#39;; frame-src https: http:;">',
    `<title>${title}</title>`,
    "<style>",
    "html,body{margin:0;min-height:100%;background:#fff;color:#111;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
    "body{padding:16px;}",
    "img,svg,video,canvas{max-width:100%;height:auto;}",
    "*{box-sizing:border-box;}",
    "</style>",
    "</head>",
    "<body>",
    html,
    "</body>",
    "</html>",
  ].join("\n");
}

export function renderHtmlPreview(
  container: HTMLElement,
  html: string,
  options: HtmlPreviewOptions = {},
): HtmlPreviewRenderResult {
  const wrapper = document.createElement("div");
  wrapper.className = HTML_PREVIEW_CLASS;
  const iframe = document.createElement("iframe");
  iframe.className = HTML_PREVIEW_IFRAME_CLASS;
  iframe.title = options.title?.trim() || "HTML Preview";
  iframe.referrerPolicy = "no-referrer";
  iframe.setAttribute("sandbox", HTML_PREVIEW_IFRAME_SANDBOX);
  const srcdoc = buildHtmlPreviewDocument(html, options);
  iframe.srcdoc = srcdoc;
  wrapper.appendChild(iframe);
  container.appendChild(wrapper);

  return {
    wrapper,
    iframe,
    srcdoc,
    sandbox: HTML_PREVIEW_IFRAME_SANDBOX,
  };
}

export function renderSandboxedHtmlPreview(
  container: HTMLElement,
  srcdoc: string,
  options: HtmlPreviewOptions = {},
): HtmlPreviewRenderResult {
  const wrapper = document.createElement("div");
  wrapper.className = HTML_PREVIEW_CLASS;
  const iframe = document.createElement("iframe");
  iframe.className = HTML_PREVIEW_IFRAME_CLASS;
  iframe.title = options.title?.trim() || "HTML Preview";
  iframe.referrerPolicy = "no-referrer";
  iframe.setAttribute("sandbox", HTML_PREVIEW_IFRAME_SANDBOX);
  iframe.srcdoc = srcdoc;
  wrapper.appendChild(iframe);
  container.appendChild(wrapper);

  return {
    wrapper,
    iframe,
    srcdoc,
    sandbox: HTML_PREVIEW_IFRAME_SANDBOX,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
