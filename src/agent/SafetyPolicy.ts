import {
  BrowserClickInput,
  BrowserOpenInput,
  BrowserTypeInput,
  SafetyDecision,
  ToolRisk,
} from "./ToolContracts";

export interface SafetyContext {
  isDesktop: boolean;
  browserToolsEnabled: boolean;
  experienceMemoryEnabled: boolean;
  companionHealthy: boolean;
  currentUrl?: string;
  visibleText?: string;
  candidateLabel?: string;
  candidateRole?: string;
  candidateHref?: string;
  explicitUserApproval?: boolean;
}

const HIGH_RISK_PATTERNS = [
  /password/i,
  /log\s*in/i,
  /sign\s*in/i,
  /checkout/i,
  /payment/i,
  /purchase/i,
  /buy\s+now/i,
  /submit/i,
  /upload/i,
  /delete/i,
  /remove/i,
  /download/i,
  /\.exe\b/i,
  /\.dmg\b/i,
  /\.msi\b/i,
  /\.pkg\b/i,
  /\.sh\b/i,
];

const NEVER_APPROVE_PATTERNS = [
  /password/i,
  /credential/i,
  /checkout/i,
  /payment/i,
  /purchase/i,
  /buy\s+now/i,
  /upload/i,
  /\.exe\b/i,
  /\.dmg\b/i,
  /\.msi\b/i,
  /\.pkg\b/i,
  /\.sh\b/i,
];

const BLOCKED_URL_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
]);

export class SafetyPolicy {
  evaluateBrowserOpen(input: BrowserOpenInput, ctx: SafetyContext): SafetyDecision {
    const base = this.browserBaseCheck(ctx);
    if (base.status !== "allow") return base;

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return this.block("Invalid URL.", ["invalid_url"]);
    }

    if (BLOCKED_URL_PROTOCOLS.has(parsed.protocol)) {
      return this.block(`Blocked URL protocol: ${parsed.protocol}`, ["blocked_protocol"]);
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return this.block(`Unsupported URL protocol: ${parsed.protocol}`, ["unsupported_protocol"]);
    }

    if (parsed.username || parsed.password) {
      return this.block("Browser URLs with credentials are blocked.", ["url_credentials"]);
    }

    if (isPrivateOrLocalHostname(parsed.hostname)) {
      return this.block("Local and private network browser targets are blocked.", [
        "local_or_private_network",
      ]);
    }

    return this.allow("Open page is observational until further action.", "low", ["browser_open"]);
  }

  evaluateBrowserClick(input: BrowserClickInput, ctx: SafetyContext): SafetyDecision {
    const base = this.browserBaseCheck(ctx);
    if (base.status !== "allow") return base;

    const text = [
      ctx.visibleText,
      ctx.candidateLabel,
      ctx.candidateRole,
      ctx.candidateHref,
      input.selector,
    ].filter(Boolean).join("\n");

    if (this.matchesHighRisk(text)) {
      if (this.matchesNeverApprove(text)) {
        return this.block("Blocked high-risk browser click.", ["high_risk_click"]);
      }

      if (ctx.explicitUserApproval) {
        return this.allow(
          "High-risk browser click allowed after explicit one-shot user approval.",
          "high",
          ["high_risk_click", "explicit_user_approval"],
        );
      }

      return this.requireApproval(
        "Click appears high-risk and requires explicit approval.",
        ["high_risk_click"],
      );
    }

    return this.allow("Browser click allowed as medium-risk supervised action.", "medium", [
      "browser_click",
    ]);
  }

  evaluateBrowserType(input: BrowserTypeInput, ctx: SafetyContext): SafetyDecision {
    const base = this.browserBaseCheck(ctx);
    if (base.status !== "allow") return base;

    const text = [
      input.text,
      input.selector,
      ctx.visibleText,
      ctx.candidateLabel,
      ctx.candidateRole,
    ].filter(Boolean).join("\n");

    if (this.matchesHighRisk(text)) {
      if (this.matchesNeverApprove(text)) {
        return this.block("Blocked high-risk typing action.", ["high_risk_type"]);
      }

      if (ctx.explicitUserApproval) {
        return this.allow(
          "High-risk browser typing allowed after explicit one-shot user approval.",
          "high",
          ["high_risk_type", "explicit_user_approval"],
        );
      }

      return this.requireApproval(
        "Typing appears high-risk and requires explicit approval.",
        ["high_risk_type"],
      );
    }

    return this.allow("Browser typing allowed as medium-risk supervised action.", "medium", [
      "browser_type",
    ]);
  }

  evaluateLowRiskObservation(ctx: SafetyContext): SafetyDecision {
    const base = this.browserBaseCheck(ctx);
    if (base.status !== "allow") return base;

    return this.allow("Low-risk observation action allowed.", "low", ["observe"]);
  }

  private browserBaseCheck(ctx: SafetyContext): SafetyDecision {
    if (!ctx.isDesktop) {
      return this.block("Browser automation is desktop-only.", ["not_desktop"]);
    }

    if (!ctx.browserToolsEnabled) {
      return this.block("Browser tools are disabled in settings.", ["browser_disabled"]);
    }

    if (!ctx.companionHealthy) {
      return this.block("Companion service is unavailable.", ["companion_unavailable"]);
    }

    return this.allow("Browser base checks passed.", "low", ["browser_base"]);
  }

  private matchesHighRisk(text: string): boolean {
    return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text));
  }

  private matchesNeverApprove(text: string): boolean {
    return NEVER_APPROVE_PATTERNS.some((pattern) => pattern.test(text));
  }

  private allow(reason: string, risk: ToolRisk, policyTags: string[]): SafetyDecision {
    return { status: "allow", risk, reason, policyTags };
  }

  private requireApproval(reason: string, policyTags: string[]): SafetyDecision {
    return { status: "require_approval", risk: "high", reason, policyTags };
  }

  private block(reason: string, policyTags: string[]): SafetyDecision {
    return { status: "block", risk: "high", reason, policyTags };
  }
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!ipv4) {
    return false;
  }

  const parts = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
