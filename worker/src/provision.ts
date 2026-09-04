/**
 * POST /api/links/:linkId/wallet — mint the wallet a link is driven by.
 *
 * WHY THIS EXISTS
 * Round-3 review, B1: nothing in production ever called `createLinkWallet`. The
 * key that `linkOps` unwraps to sign every payment was written only by tests, so
 * on a real deployment `linkSigner` returned null and every payment answered
 * "This payment link is no longer active." Separately, the merchant had no way
 * to obtain the account address `registerAgent` requires — it is generated
 * inside `createLinkWallet` and returned only to its caller.
 *
 * This is that caller.
 *
 * THE ORDERING THE MERCHANT APP MUST FOLLOW
 *   1. POST here with the linkId  →  returns the account address
 *   2. batch, IN THIS ORDER:
 *        integrator.createLink(linkId, …)
 *        router.registerAgent(linkId, account)
 *
 * `registerAgent` reads `getLink` to check ownership, so `createLink` has to
 * land first WITHIN the batch. Reversed, the batch reverts on a link that does
 * not exist yet — which at least fails loudly, unlike omitting step 2 entirely.
 *
 * WHY THE ADDRESS IS MINTED BEFORE THE LINK EXISTS
 * Because the batch needs it before it is signed. That means ownership cannot
 * be checked against `link.owner` — the link is not there yet. So authorisation
 * is the strongest thing available at each moment:
 *
 *   • link does not exist yet  →  the signer must be a REGISTERED MERCHANT
 *   • link already exists      →  the signer must be its OWNER
 *
 * The second case covers retries and the merchant app recovering from a half
 * completed flow, and it is strictly stronger, so it is preferred when
 * available.
 */

import { verifyTypedData, type Address, type Hex } from "viem";
import { publicClientFor } from "./chain";
import { INTEGRATOR_ABI, type Env } from "./config";
import { createLinkWallet, linkWalletAddress, keyTtlFor, mintedBy } from "./linkWallet";
import { predictAccount } from "./aa";
import { json, badRequest, isHex32, normalizeLinkId } from "./http";

/** How long a provisioning signature stays valid. */
export const PROVISION_WINDOW_SECONDS = 300;

interface ProvisionBody {
  signer?: string;
  signature?: string;
  expiry?: number;
}

const MERCHANT_INFO_ABI = [
  {
    type: "function",
    name: "getMerchantInfo",
    stateMutability: "view",
    inputs: [{ name: "merchant", type: "address" }],
    outputs: [
      { name: "encPayoutId", type: "bytes" },
      { name: "shopName", type: "string" },
      { name: "currency", type: "bytes32" },
      { name: "isRegistered", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;

/**
 * Verifies the merchant signed THIS request, for THIS link.
 *
 * The linkId is inside the signature. Without it a captured signature would
 * mint a wallet for any link the holder named — and since the address is what
 * gets bound on-chain, that is the whole authorisation.
 */
async function verifyMerchant(
  env: Env,
  linkId: string,
  body: ProvisionBody
): Promise<Address | null> {
  const { signer, signature, expiry } = body;
  if (!signer || !signature || typeof expiry !== "number") return null;

  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now || expiry > now + PROVISION_WINDOW_SECONDS) return null;

  try {
    const ok = await verifyTypedData({
      address: signer as Address,
      // Bound to this chain and this integrator, so a signature from a testnet
      // deployment is not a signature here.
      domain: {
        name: "P2P Merchant Terminal Admin",
        version: "1",
        chainId: Number(env.CHAIN_ID),
        verifyingContract: env.INTEGRATOR_ADDRESS as Address,
      },
      types: {
        LinkWallet: [
          { name: "linkId", type: "bytes32" },
          { name: "expiry", type: "uint256" },
        ],
      },
      primaryType: "LinkWallet",
      message: { linkId: linkId as Hex, expiry: BigInt(expiry) },
      signature: signature as Hex,
    });
    return ok ? (signer as Address) : null;
  } catch {
    return null;
  }
}

/**
 * Is this signer allowed to mint a wallet for this link?
 *
 * Returns the link's expiry when allowed (needed to size the key's lifetime),
 * or null. A frozen merchant is refused: they cannot take payments, so issuing
 * them a link wallet only creates something that fails later.
 */
async function authorise(
  env: Env,
  linkId: string,
  signer: Address
): Promise<{ ok: true; expiresAt: bigint } | { ok: false }> {
  const client = publicClientFor(env);

  // Preferred: the link already exists, so ownership is unambiguous.
  try {
    const link = (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [linkId as Hex],
    })) as readonly [Address, bigint, Hex, bigint, number, number, number, number];

    if (link[0].toLowerCase() !== signer.toLowerCase()) return { ok: false };
    return { ok: true, expiresAt: link[3] };
  } catch {
    // `getLink` reverts LinkNotFound when the link is not created yet, which is
    // the NORMAL case: the merchant mints the wallet in order to batch
    // createLink with registerAgent. Fall through to the weaker check.
  }

  try {
    const info = (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: MERCHANT_INFO_ABI,
      functionName: "getMerchantInfo",
      args: [signer],
    })) as readonly [Hex, string, Hex, boolean, boolean];

    const registered = info[3];
    const frozen = info[4];
    if (!registered || frozen) return { ok: false };
    // The link does not exist, so its expiry is unknown. Treat it as
    // never-expiring: the key then lives as long as any link could, and
    // `createLinkWallet` records the actual expiry on a later re-read if needed.
    return { ok: true, expiresAt: 0n };
  } catch {
    return { ok: false };
  }
}

/**
 * Mints, or returns, the link's wallet address.
 *
 * IDEMPOTENT. The merchant app may retry after a dropped response, and a second
 * mint would produce a different address — which `registerAgent`, being
 * write-once, would then refuse forever. So an existing record is returned
 * as-is, provided the same merchant is asking.
 */
export async function handleProvisionWallet(
  req: Request,
  env: Env,
  rawLinkId: string
): Promise<Response> {
  const linkId = normalizeLinkId(rawLinkId);
  if (!isHex32(linkId)) return badRequest("That payment link address is not valid.");

  const body = (await req.json().catch(() => ({}))) as ProvisionBody;

  const signer = await verifyMerchant(env, linkId, body);
  // The same answer for a bad signature and for an unauthorised signer —
  // distinguishing them tells a prober which half to work on.
  if (!signer) return json({ error: "Not authorised." }, 403);

  const existingOwner = await mintedBy(env, linkId);
  if (existingOwner) {
    if (existingOwner.toLowerCase() !== signer.toLowerCase()) {
      // Someone else already minted for this link id. Refusing rather than
      // overwriting: overwriting would strand whatever they registered, and
      // link ids are merchant-derived so a genuine collision is not expected.
      return json({ error: "This link id is already in use." }, 409);
    }
    const account = await linkWalletAddress(env, linkId);
    if (account) return json({ linkId, account, existing: true });
    // A record whose address is unreadable is worse than none — fall through
    // and mint again rather than hand back nothing.
  }

  const allowed = await authorise(env, linkId, signer);
  if (!allowed.ok) return json({ error: "Not authorised." }, 403);

  const account = await createLinkWallet(
    env,
    linkId,
    keyTtlFor(allowed.expiresAt),
    (owner) => predictAccount(env, owner),
    signer
  );

  return json({
    linkId,
    account,
    existing: false,
    // Stated in the response because getting it wrong is silent: reversed, the
    // batch reverts; omitted, the link looks correct and can never be paid.
    next: "batch createLink(linkId, …) then registerAgent(linkId, account), in that order",
  });
}
