import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|mfa|backup)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(entry)]));
  }
  return value;
}

export function writeLog(level: "debug" | "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, details: redact(details) })}\n`);
}

export type LoggedRequest = Request & { requestId?: string; startedAt?: number; ipHash?: string };

export function requestLogging(req: LoggedRequest, res: Response, next: NextFunction) {
  req.requestId = req.header("x-request-id")?.slice(0, 64) || randomUUID();
  req.startedAt = Date.now();
  res.setHeader("x-request-id", req.requestId);
  res.on("finish", () => writeLog("info", "http.request.completed", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs: Date.now() - (req.startedAt ?? Date.now()),
  }));
  next();
}
