/**
 * Session JWTs issued after a successful x402 payment.
 * 1-hour expiry, matching the 1-hour paid session window.
 */
import jwt from "jsonwebtoken";
import { requireJwtSecret } from "./env.js";

const SESSION_TTL_SECONDS = 60 * 60; // 1 hour

export interface SessionPayload {
  sub: "x402-test-session";
  payer?: string;
}

export function issueSessionToken(payer?: string): { token: string; expires_at: string } {
  const secret = requireJwtSecret();
  const payload: SessionPayload = { sub: "x402-test-session", payer };
  const token = jwt.sign(payload, secret, { expiresIn: SESSION_TTL_SECONDS });
  const expires_at = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  return { token, expires_at };
}

export function verifySessionToken(token: string): SessionPayload {
  const secret = requireJwtSecret();
  return jwt.verify(token, secret) as SessionPayload;
}
