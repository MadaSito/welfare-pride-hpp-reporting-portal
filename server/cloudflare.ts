import type { NextFunction, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AuthenticatedRequest } from "./security";
import { listIpRules } from "./repository";

/** Extract real client IP trusting Cloudflare proxy headers */
export function extractClientInfo(req: AuthenticatedRequest): { ip: string; country: string | null } {
  const cfIp = req.header("cf-connecting-ip")?.trim();
  const cfCountry = req.header("cf-ipcountry")?.trim() || null;
  const xff = req.header("x-forwarded-for");
  const firstXff = xff?.split(",")[0]?.trim();
  const ip = cfIp || firstXff || req.socket.remoteAddress || "127.0.0.1";
  return { ip, country: cfCountry };
}

export function edgeInfoMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const { ip, country } = extractClientInfo(req);
  req.realIp = ip;
  req.geoCountry = country || undefined;
  next();
}

/** Check IP allow/deny rules and geo-block rules against the database */
export function ipRuleCheck(req: AuthenticatedRequest): { allowed: boolean; reason?: string } {
  const ip = req.realIp || "127.0.0.1";
  const country = (req.geoCountry || "").toUpperCase();
  const rules = listIpRules();

  // Deny rules take precedence
  for (const r of rules) {
    if (r.type === "deny" && r.value === ip) return { allowed: false, reason: "IP explicitly denied" };
  }
  // Geo block rules
  for (const r of rules) {
    if (r.type === "geo_block" && r.value.toUpperCase() === country && country) {
      return { allowed: false, reason: `Traffic from region ${country} is blocked` };
    }
  }
  // Allowlist rules — if any allow rule exists, IP MUST match one
  const allowRules = rules.filter(r => r.type === "allow");
  if (allowRules.length > 0 && !allowRules.some(r => r.value === ip)) {
    return { allowed: false, reason: "IP not in allowlist" };
  }
  return { allowed: true };
}

export function ipFirewallMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Never firewall health checks or static branding assets
  if (req.path === "/api/v1/health" || req.path.startsWith("/assets/branding")) return next();
  const { allowed, reason } = ipRuleCheck(req);
  if (!allowed) {
    res.status(403).json({ error: "FORBIDDEN_EDGE_POLICY", reason, requestId: req.requestId });
    return;
  }
  next();
}

/** Create rate limiters keyed on real IP */
export function createLimiters() {
  const keyGenerator = (req: AuthenticatedRequest) => req.realIp || req.ip || "unknown";

  const standard = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.STANDARD_RATELIMIT_MAX || 120),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { error: "RATE_LIMIT_EXCEEDED" },
  });

  const authStrict = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATELIMIT_MAX || 15),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { error: "AUTH_RATE_LIMIT_EXCEEDED" },
  });

  const writeOps = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.WRITEOPS_RATELIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { error: "WRITE_RATE_LIMIT_EXCEEDED" },
  });

  return { standard, authStrict, writeOps };
}
