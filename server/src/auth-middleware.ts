/**
 * Bearer-token / ?token= query param auth for JWT-protected routes,
 * matching the existing $ELEC API convention (see mcp-server/src/elec-client.ts).
 */
import type { NextFunction, Request, Response } from "express";
import { verifySessionToken } from "./jwt.js";

export function requireSessionToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = headerToken ?? queryToken;

  if (!token) {
    res.status(401).json({ error: "Missing session token (Authorization: Bearer <token> or ?token=)" });
    return;
  }

  try {
    verifySessionToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session token" });
  }
}
