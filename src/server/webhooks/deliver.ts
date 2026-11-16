import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { adminDb } from "@/server/db/admin";

/**
 * The webhook delivery worker. Runs after requests that may have queued events
 * and from a daily cron sweep. It only ever calls two database functions:
 * webhook_claim() and webhook_report().
 */

const TIMEOUT_MS = 8000;

/** The signature header value: `t=<unix seconds>,v1=<HMAC-SHA256 of "t.body">`. */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** True for addresses a webhook must never reach: loopback, private, link-local and the like. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return (
    v6 === "::" || v6 === "::1" || v6.startsWith("::ffff:") ||
    /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") || v6.startsWith("64:ff9b:")
  );
}

/** Refuse anything but https to a public host. Throws with a short reason. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("not a plain https URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("host is not public");
  return url;
}

interface Claimed {
  delivery_id: number;
  url: string;
  secret: string;
  event: string;
  payload: unknown;
}

async function send(delivery: Claimed): Promise<number> {
  try {
    const url = await assertPublicUrl(delivery.url);
    const body = JSON.stringify(delivery.payload);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Bizzy-Webhooks/1",
        "X-Bizzy-Event": delivery.event,
        "X-Bizzy-Delivery": String(delivery.delivery_id),
        "X-Bizzy-Signature": signPayload(delivery.secret, body),
      },
      body,
      redirect: "manual", // a redirect could point somewhere private
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return 0; // refused URL, DNS failure, timeout or network error
  }
}

/**
 * Deliver due webhook events. Does nothing when the service-role key is not
 * configured. Returns how many deliveries were attempted. Never throws.
 */
export async function drainWebhooks(limit = 20): Promise<number> {
  try {
    const db = adminDb();
    if (!db) return 0;
    const { data, error } = await db.rpc("webhook_claim", { p_limit: limit });
    if (error) {
      console.error("[webhooks] could not claim deliveries", error.code);
      return 0;
    }
    const claimed = (data ?? []) as Claimed[];
    await Promise.all(
      claimed.map(async (delivery) => {
        const status = await send(delivery);
        const report = await db.rpc("webhook_report", { p_delivery: delivery.delivery_id, p_status: status });
        if (report.error) console.error("[webhooks] could not record delivery", report.error.code);
      }),
    );
    return claimed.length;
  } catch (error) {
    console.error("[webhooks] drain failed", error);
    return 0;
  }
}
