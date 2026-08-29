/**
 * Operator endpoints for the blocklist.
 *
 * WHY UNBLOCKING IS NOT OPTIONAL
 * The blocklist keys on an IP address, and an IP address is not a person.
 * Mobile carriers put very large numbers of subscribers behind one address —
 * in India that is the normal case — so a block earned by one abuser can catch
 * people who have done nothing. That is not a flaw to be argued away; it is the
 * cost of the control, and it is only acceptable because an operator can SEE
 * the blocks and LIFT them.
 *
 * A blocking rule with no reviewable list and no undo is not a fraud control,
 * it is a way to lose customers quietly.
 *
 * AUTHENTICATION
 * A shared secret in a header, compared in constant time. Deliberately not a
 * role in the contract: this touches no funds and no chain state, so putting it
 * on-chain would buy nothing and cost a transaction per support ticket. If
 * these ever gain the power to move money, that judgement has to be revisited.
 */

import type { Env } from "./config";
import { json } from "./http";
import { unblockIp, blockIp, blockRecord, listBlocked } from "./blocklist";

/** Constant-time compare, so the secret cannot be recovered by timing. */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Guards every operator route.
 *
 * Fails CLOSED when no secret is configured. The Turnstile gate fails open, for
 * a reason that does not apply here: leaving that off degrades a spam control on
 * a path that is otherwise safe, while leaving this off would let anyone lift a
 * block. Refusing is the correct default when the consequence of an unset
 * variable is an open door.
 */
function authorised(req: Request, env: Env): boolean {
  if (!env.ADMIN_SECRET) return false;
  return secretMatches(req.headers.get("X-Admin-Secret"), env.ADMIN_SECRET);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

/** Rejects anything that is not plausibly an address, so a stray value cannot
 *  write junk keys into the store. */
const looksLikeIp = (s: string) => IPV4.test(s) || IPV6.test(s);

/**
 * The operator API.
 *
 *   GET    /api/admin/blocks          list current blocks
 *   POST   /api/admin/blocks          { ip, reason? }  block by hand
 *   DELETE /api/admin/blocks          { ip }           lift a block
 */
export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  if (!authorised(req, env)) {
    // The same answer whether the secret is wrong or unset — distinguishing
    // them tells an attacker whether the door exists.
    return json({ error: "Not found." }, 404);
  }

  if (req.method === "GET") {
    // A complaint arrives about ONE person, so the review starts with one
    // lookup — not by reading a list of two hundred and hoping to spot them.
    // `?ip=` is the support path; the full list is the audit path.
    const wanted = new URL(req.url).searchParams.get("ip");
    if (wanted !== null) {
      const ip = wanted.trim();
      if (!looksLikeIp(ip)) return json({ error: "Provide a valid ip." }, 400);
      const record = await blockRecord(env, ip);
      return json({
        ip,
        blocked: record !== null,
        record,
        // The strike count is shown even when there is no block yet: someone on
        // two strikes who is complaining is worth seeing before they hit three.
        strikes: Number((await env.KV.get(`claim:strikes:${ip}`)) ?? "0"),
      });
    }

    // Listing is the audit: an operator needs to see WHEN and for HOW MANY
    // strikes, which is what separates a fraudster from a shared carrier
    // address catching people who did nothing.
    return json({ blocks: await listBlocked(env) });
  }

  const body = (await req.json().catch(() => ({}))) as { ip?: string; reason?: string };
  const ip = String(body.ip ?? "").trim();
  if (!looksLikeIp(ip)) return json({ error: "Provide a valid ip." }, 400);

  if (req.method === "DELETE") {
    const existed = await unblockIp(env, ip);
    // The strike count is cleared too — leaving it would put a wrongly-blocked
    // person one claim away from being blocked again, which is not what an
    // operator means by "unblock".
    return json({ ip, unblocked: existed });
  }

  if (req.method === "POST") {
    await blockIp(env, ip, 0, String(body.reason ?? "blocked by operator"));
    return json({ ip, blocked: true, record: await blockRecord(env, ip) });
  }

  return json({ error: "Not found." }, 404);
}
