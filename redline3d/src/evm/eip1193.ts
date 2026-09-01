/**
 * The pure EIP-1193 core of the EVM money path — extracted OUT of privy-evm-island.ts so it can be
 * tested. The island's top-level `react` / `@privy-io/react-auth` imports make that module
 * unimportable from a test process, which left the exact bytes that decide where a player's money
 * goes (personal_sign param order, the transfer calldata, the chain guard) covered by nothing.
 *
 * Everything here is provider-agnostic and dependency-free beyond viem's encoder: give it a
 * `{ request }` object and plain values, get back the payloads. The island is now a thin binding
 * from Privy's wallet to these builders.
 */
import { encodeFunctionData, erc20Abi, zeroAddress } from "viem";

/** The narrow slice of an EIP-1193 provider this module needs. */
export interface Eip1193Provider {
  request: (r: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/** UTF-8 → 0x-hex. `personal_sign` takes hex data; TextEncoder + a manual nibble loop keeps this
 *  Buffer-free (there is no node Buffer in the browser bundle) and encodes BYTES, so multibyte
 *  characters in a server challenge survive the round trip. */
export function utf8ToHex(message: string): `0x${string}` {
  let out = "";
  for (const byte of new TextEncoder().encode(message)) out += byte.toString(16).padStart(2, "0");
  return `0x${out}`;
}

/**
 * `personal_sign` params, in the order the spec fixes them: **[data, address]**. This is the exact
 * inverse of `eth_sign`'s [address, data]; swapping them makes the wallet sign the address bytes
 * and hands the server a signature that can never recover to the bound wallet.
 */
export function buildPersonalSignParams(message: string, address: string): [`0x${string}`, string] {
  return [utf8ToHex(message), address];
}

/**
 * The `eth_sendTransaction` object for an ERC-20 USDC transfer.
 *
 * Two guards live here rather than at the call site so both the Privy and dev paths inherit them:
 *  - the recipient is LOWERCASED. viem 2.x validates EIP-55 at encode time, so a hand-typed or
 *    uppercased treasury address would throw `InvalidAddressError` on every real transfer while an
 *    all-lowercase one always passes;
 *  - the zero address is REFUSED. `transfer(0x0, n)` encodes perfectly and burns the funds
 *    irrecoverably, so it fails before anything is built.
 *
 * `chainId` is included in the payload deliberately: without it, a provider whose chain state moved
 * between the `ensureChain` check and the send would sign on the wrong network. With it the
 * provider rejects the mismatch itself, closing that TOCTOU window.
 */
export function buildUsdcTransferTx(input: {
  from: string;
  to: string;
  usdc: string;
  amountBaseUnits: bigint;
  chainId: number;
}): { from: string; to: `0x${string}`; data: `0x${string}`; chainId: number } {
  // Validate the caller's argument before the build's config: a bad recipient is the more
  // actionable error of the two.
  const recipient = input.to.toLowerCase() as `0x${string}`;
  if (recipient === zeroAddress) throw new Error("evm_transfer_to_zero");
  if (!input.usdc) throw new Error("evm_usdc_address_unset");
  return {
    from: input.from,
    to: input.usdc.toLowerCase() as `0x${string}`,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, input.amountBaseUnits],
    }),
    chainId: input.chainId,
  };
}

/**
 * Pin the provider to `chainId` before value moves. `supportedChains`/`defaultChain` on the Privy
 * config already put the embedded wallet on the right chain, so the common path is the single cheap
 * `eth_chainId` read; the switch is the fallback, and a still-wrong chain after it is a hard
 * failure rather than a transfer broadcast on the wrong network.
 *
 * Fails CLOSED in every direction: a rejected switch, a switch that silently leaves the wallet
 * elsewhere, a non-string reply, and an `eth_chainId` that rejects outright all end in a throw.
 */
export async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const chainIdHex = `0x${chainId.toString(16)}`;
  const on = async () => {
    const id = (await provider.request({ method: "eth_chainId" })) as string;
    return typeof id === "string" && Number.parseInt(id, 16) === chainId;
  };
  if (await on()) return;
  await provider
    .request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] })
    .catch(() => {
      /* re-checked below — some providers reject an already-correct switch */
    });
  if (!(await on())) throw new Error("evm_wrong_chain");
}
