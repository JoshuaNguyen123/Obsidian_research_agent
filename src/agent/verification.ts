import {
  parseJsonCanvas,
  validateJsonCanvas,
  type JsonCanvasValidationResult,
} from "../design/jsonCanvas";
import { HTML_PREVIEW_IFRAME_SANDBOX } from "../ui/htmlPreview";

export interface VerificationResult {
  ok: boolean;
  errors: string[];
}

export interface CanvasArtifactVerification extends VerificationResult {
  nodeCount: number;
  edgeCount: number;
}

export interface SvgArtifactVerification extends VerificationResult {
  shapeCount: number;
}

export interface CodeRequestVerification extends VerificationResult {
  language: string;
}

export function verifyCanvasArtifact(content: string): CanvasArtifactVerification {
  try {
    const canvas = parseJsonCanvas(content);
    const validation: JsonCanvasValidationResult = validateJsonCanvas(canvas);
    return {
      ok: validation.ok,
      errors: validation.errors,
      nodeCount: validation.nodeCount,
      edgeCount: validation.edgeCount,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [getErrorMessage(error)],
      nodeCount: 0,
      edgeCount: 0,
    };
  }
}

export function verifySvgArtifact(content: string): SvgArtifactVerification {
  const errors: string[] = [];
  const trimmed = content.trim();

  if (!/^<svg[\s>]/i.test(trimmed)) {
    errors.push("SVG artifact must start with an <svg> element.");
  }

  if (/<script[\s>]/i.test(trimmed)) {
    errors.push("SVG artifact must not include script elements.");
  }

  if (/\son[a-z]+\s*=/i.test(trimmed)) {
    errors.push("SVG artifact must not include inline event handlers.");
  }

  if (/javascript:/i.test(trimmed)) {
    errors.push("SVG artifact must not include javascript: URLs.");
  }

  return {
    ok: errors.length === 0,
    errors,
    shapeCount: countSvgShapes(trimmed),
  };
}

export function verifyCodeRequest(
  language: string,
  code: string,
): CodeRequestVerification {
  const errors: string[] = [];
  const normalizedLanguage = language.trim().toLowerCase();

  if (!normalizedLanguage) {
    errors.push("Code language is required.");
  }

  if (!code.trim()) {
    errors.push("Code content is required.");
  }

  return {
    ok: errors.length === 0,
    errors,
    language: normalizedLanguage,
  };
}

export function verifyHtmlPreviewDocument(content: string): VerificationResult {
  const errors: string[] = [];

  if (!/<!doctype html>/i.test(content)) {
    errors.push("HTML preview must be a complete srcdoc document.");
  }

  if (!/Content-Security-Policy/i.test(content)) {
    errors.push("HTML preview must include a Content-Security-Policy meta tag.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function verifyHtmlPreviewSandbox(sandbox: string): VerificationResult {
  const errors: string[] = [];

  if (sandbox !== HTML_PREVIEW_IFRAME_SANDBOX) {
    errors.push("HTML preview iframe sandbox does not match the expected policy.");
  }

  if (/\ballow-scripts\b/.test(sandbox)) {
    errors.push("HTML preview iframe sandbox must not allow scripts.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function verifySourceNote(content: string, url: string): VerificationResult {
  const errors: string[] = [];

  if (!content.includes(url)) {
    errors.push("Source note must include the source URL.");
  }

  if (!/\bOpened\b/i.test(content)) {
    errors.push("Source note must include an opened timestamp.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function countSvgShapes(content: string): number {
  const matches = content.match(/<(rect|circle|ellipse|line|polyline|polygon|path|text)\b/gi) ?? [];
  return Math.max(0, matches.length - 1);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
