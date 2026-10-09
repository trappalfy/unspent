import "server-only";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { network } from "./env";

// Session after Sign-In With Solana: an httpOnly cookie holding a signed JWT (brief 10).

export const SESSION_COOKIE = "usp_session";
export const SIWS_COOKIE = "usp_siws";
const SESSION_TTL_SEC = 7 * 24 * 3600;
export const SIWS_TTL_SEC = 10 * 60;

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return new TextEncoder().encode(s);
}

const cookieBase = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function signToken(payload: Record<string, unknown>, ttlSec: number, audience: string) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .setAudience(audience)
    .sign(secret());
}

export async function verifyToken<T>(token: string | undefined, audience: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience, algorithms: ["HS256"] });
    return payload as T;
  } catch {
    return null;
  }
}

export type Session = { address: string; network: string };

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const p = await verifyToken<{ sub: string; net: string }>(jar.get(SESSION_COOKIE)?.value, "session");
  if (!p || p.net !== network) return null;
  return { address: p.sub, network: p.net };
}

export async function startSession(address: string) {
  const token = await signToken({ sub: address, net: network }, SESSION_TTL_SEC, "session");
  (await cookies()).set(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_SEC });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function setSiwsCookie(token: string) {
  (await cookies()).set(SIWS_COOKIE, token, { ...cookieBase, maxAge: SIWS_TTL_SEC });
}

export async function takeSiwsCookie(): Promise<string | undefined> {
  const jar = await cookies();
  const v = jar.get(SIWS_COOKIE)?.value;
  jar.delete(SIWS_COOKIE);
  return v;
}
