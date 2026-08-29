import { describe, it, expect, beforeEach } from "vitest";
import { blockIp, unblockIp, blockRecord, listBlocked } from "../src/blocklist";
import {
  blockedForFalseClaims,
  falseClaimWarning,
  rememberMarkPaid,
  recordFalseClaim,
  MAX_FALSE_CLAIMS,
} from "../src/claims";
import { handleAdmin } from "../src/admin";
import type { Env } from "../src/config";

/**
 * Blocking a repeat false claimant.
 *
 * The thing under test is a trade, not a guarantee. An IP is not a person: it
 * OVER-blocks, because mobile carriers put very many subscribers behind one
 * address, and it UNDER-blocks, because changing networks defeats it in
 * seconds. It buys friction against casual abuse and nothing against a
 * determined attacker.
 *
 * That trade is only acceptable because an operator can see the blocks and lift
 * them, so the unblock path is tested as carefully as the block path.
 */
const IP = "203.0.113.7";
const OTHER = "203.0.113.9";
const SECRET = "operator-secret-value";

function fakeEnv(over: Partial<Env> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    ADMIN_SECRET: SECRET,
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async ({ prefix = "", limit = 1000 } = {}) => ({
        keys: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name })),
      }),
    } as unknown as KVNamespace,
    ...over,
  } as Env;
  return { env, store };
}

describe("earning a block", () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = fakeEnv());
  });

  const falseClaim = async (orderId: bigint, ip = IP) => {
    await rememberMarkPaid(env, orderId, ip);
    await recordFalseClaim(env, orderId);
  };

  it("lets an honest customer through untouched", async () => {
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(await falseClaimWarning(env, IP)).toBeNull();
  });

  it("warns but does not block before the limit", async () => {
    // A failed bank transfer is far more likely than fraud, so the early
    // strikes tell the person plainly rather than counting down in silence.
    for (let i = 1; i < MAX_FALSE_CLAIMS; i++) {
      await falseClaim(BigInt(i));
      expect(await blockedForFalseClaims(env, IP)).toBeNull();
      expect(await falseClaimWarning(env, IP)).toContain("more time");
    }
  });

  it("blocks on the third false claim", async () => {
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();
    expect(await blockRecord(env, IP)).not.toBeNull();
    expect((await blockRecord(env, IP))!.strikes).toBe(MAX_FALSE_CLAIMS);
  });

  it("survives the strike counter expiring — waiting does not clear it", async () => {
    // The counter forgets after a day. A day is a cheap wait for someone whose
    // attempts cost them nothing, so the durable record is what actually holds.
    const { env: e, store } = fakeEnv();
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) {
      await rememberMarkPaid(e, BigInt(i), IP);
      await recordFalseClaim(e, BigInt(i));
    }
    store.delete(`claim:strikes:${IP}`); // as TTL expiry would
    expect(await blockedForFalseClaims(e, IP)).toBeTruthy();
  });

  it("does not touch anyone else", async () => {
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    expect(await blockedForFalseClaims(env, OTHER)).toBeNull();
  });

  it("is keyed on the address, so a fresh profile changes nothing", async () => {
    // The whole point of blocking here rather than on an account: there is no
    // account, and a new one is free to create.
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();
  });

  it("says nothing an abuser can tune against", async () => {
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    const msg = (await blockedForFalseClaims(env, IP))!;
    // No strike count, no duration, no "blocked" — telling them what tripped it
    // tells them what to avoid. It points at a human instead.
    expect(msg).not.toMatch(/block|strike|\d+ (day|hour)/i);
    expect(msg).toContain("merchant");
  });
});

describe("lifting a block", () => {
  let env: Env;

  beforeEach(async () => {
    ({ env } = fakeEnv());
    await blockIp(env, IP, 3);
  });

  const admin = (method: string, body?: unknown, secret: string | null = SECRET) =>
    handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Admin-Secret": secret } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env
    );

  it("unblocks, and clears the strikes with it", async () => {
    // Leaving the count would put a wrongly-blocked person one claim from being
    // blocked again — not what an operator means by "unblock".
    await env.KV.put(`claim:strikes:${IP}`, "3");
    const res = await admin("DELETE", { ip: IP });

    expect(res.status).toBe(200);
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(await env.KV.get(`claim:strikes:${IP}`)).toBeNull();
  });

  it("lists blocks so over-blocking is visible", async () => {
    // A control that can catch innocent people and cannot be audited is a
    // liability, not a control.
    await blockIp(env, OTHER, 5, "manual");
    const body = (await (await admin("GET")).json()) as { blocks: any[] };
    const ips = body.blocks.map((b) => b.ip);
    expect(ips).toContain(IP);
    expect(ips).toContain(OTHER);
    expect(body.blocks.find((b) => b.ip === OTHER).record.reason).toBe("manual");
  });

  it("lets an operator block by hand", async () => {
    const res = await admin("POST", { ip: OTHER, reason: "confirmed abuse" });
    expect(res.status).toBe(200);
    expect((await blockRecord(env, OTHER))!.reason).toBe("confirmed abuse");
  });

  it("reports honestly when there was nothing to unblock", async () => {
    const body = (await (await admin("DELETE", { ip: OTHER })).json()) as { unblocked: boolean };
    expect(body.unblocked).toBe(false);
  });

  it("rejects anything that is not an address", async () => {
    for (const bad of ["", "not-an-ip", "1.2.3", "'; DROP", "a".repeat(200)]) {
      expect((await admin("DELETE", { ip: bad })).status).toBe(400);
    }
  });
});

describe("the operator door", () => {
  it("answers 404 without the secret — not 401", async () => {
    // A 401 confirms the endpoint exists. 404 says nothing.
    const { env } = fakeEnv();
    await blockIp(env, IP, 3);

    for (const secret of [null, "wrong", SECRET.slice(0, -1)]) {
      const res = await handleAdmin(
        new Request("https://w/api/admin/blocks", {
          method: "DELETE",
          headers: secret ? { "X-Admin-Secret": secret } : {},
          body: JSON.stringify({ ip: IP }),
        }),
        env
      );
      expect(res.status).toBe(404);
    }
    // And nothing was lifted.
    expect(await blockRecord(env, IP)).not.toBeNull();
  });

  it("fails CLOSED when no secret is configured", async () => {
    // Turnstile fails open, for a reason that does not apply here: leaving that
    // off degrades a spam control, while leaving this off would let anyone lift
    // a fraud block.
    const { env } = fakeEnv({ ADMIN_SECRET: undefined });
    await blockIp(env, IP, 3);

    const res = await handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method: "DELETE",
        headers: { "X-Admin-Secret": "anything" },
        body: JSON.stringify({ ip: IP }),
      }),
      env
    );
    expect(res.status).toBe(404);
    expect(await blockRecord(env, IP)).not.toBeNull();
  });
});

/**
 * The complaint flow.
 *
 * A block is automatic; lifting one is not. When someone says "I was blocked
 * unfairly", the operator needs to answer one question — is this a fraudster or
 * a shared carrier address? — and they start from that person, not from a list
 * of everyone.
 */
describe("reviewing a complaint about one person", () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = fakeEnv());
  });

  const lookup = (ip: string, secret: string | null = SECRET) =>
    handleAdmin(
      new Request(`https://w/api/admin/blocks?ip=${encodeURIComponent(ip)}`, {
        method: "GET",
        headers: secret ? { "X-Admin-Secret": secret } : {},
      }),
      env
    );

  it("answers for one address, with when and how many", async () => {
    await blockIp(env, IP, 3);
    const body = (await (await lookup(IP)).json()) as any;

    expect(body.blocked).toBe(true);
    expect(body.record.strikes).toBe(3);
    expect(body.record.at).toBeGreaterThan(0);
  });

  it("says plainly when someone is NOT blocked", async () => {
    // The complaint may be about something else entirely; the operator needs to
    // be able to rule this out in one call.
    const body = (await (await lookup(OTHER)).json()) as any;
    expect(body.blocked).toBe(false);
    expect(body.record).toBeNull();
    expect(body.strikes).toBe(0);
  });

  it("shows strikes even before a block, so a near-miss is visible", async () => {
    // Someone on two strikes who is already complaining is worth seeing before
    // they hit three and it becomes a support ticket.
    await rememberMarkPaid(env, 1n, IP);
    await recordFalseClaim(env, 1n);

    const body = (await (await lookup(IP)).json()) as any;
    expect(body.blocked).toBe(false);
    expect(body.strikes).toBe(1);
  });

  it("still refuses a lookup without the secret", async () => {
    await blockIp(env, IP, 3);
    expect((await lookup(IP, null)).status).toBe(404);
    expect((await lookup(IP, "wrong")).status).toBe(404);
  });

  it("rejects a lookup for something that is not an address", async () => {
    expect((await lookup("not-an-ip")).status).toBe(400);
  });

  it("supports the whole flow: blocked, reviewed, lifted, paying again", async () => {
    // Exactly the sequence a support ticket follows.
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) {
      await rememberMarkPaid(env, BigInt(i), IP);
      await recordFalseClaim(env, BigInt(i));
    }
    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();

    // The operator looks them up and sees the evidence.
    const review = (await (await lookup(IP)).json()) as any;
    expect(review.blocked).toBe(true);
    expect(review.record.strikes).toBe(MAX_FALSE_CLAIMS);

    // Decides it was a shared address and lifts it.
    await handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method: "DELETE",
        headers: { "X-Admin-Secret": SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ ip: IP }),
      }),
      env
    );

    // They can pay again, and are not one claim from being blocked once more.
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(((await (await lookup(IP)).json()) as any).strikes).toBe(0);
  });
});
