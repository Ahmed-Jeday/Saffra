import { Group } from "@semaphore-protocol/group";
import { Identity } from "@semaphore-protocol/identity";
import { generateProof } from "@semaphore-protocol/proof";
import { ethers } from "ethers";
import votingAbi from "../abi/VotingABI.json";
import type { SemaphoreProofPayload } from "../types/voting";

export interface LocalSemaphoreIdentity {
  commitment: string;
  exportedSecret: string;
  derivationMode: "deterministic" | "random";
  identityInstance: Identity;
}

export async function deriveIdentityFromWalletSignature(
  privateKeyHex: string,
  electionId: string
): Promise<LocalSemaphoreIdentity> {
  return deriveIdentityFromSigner(new ethers.Wallet(privateKeyHex), electionId);
}

export async function deriveIdentityFromSigner(
  signer: ethers.Signer,
  electionId: string
): Promise<LocalSemaphoreIdentity> {
  const signature = await signer.signMessage(
    `Semaphore identity, election ID: ${electionId}`
  );
  const identity = new Identity(signature);
  return {
    commitment: identity.commitment.toString(),
    exportedSecret: identity.export(),
    derivationMode: "deterministic",
    identityInstance: identity,
  };
}

export function createRandomLocalIdentity(): LocalSemaphoreIdentity {
  const identity = new Identity();
  return {
    commitment: identity.commitment.toString(),
    exportedSecret: identity.export(),
    derivationMode: "random",
    identityInstance: identity,
  };
}

export function restoreIdentityFromBackup(
  exportedSecret: string
): LocalSemaphoreIdentity {
  const identity = Identity.import(exportedSecret);
  return {
    commitment: identity.commitment.toString(),
    exportedSecret: identity.export(),
    derivationMode: "random",
    identityInstance: identity,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  bytes.forEach((byte) => {
    value += String.fromCharCode(byte);
  });
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function identityStorageKey(
  signer: ethers.Signer,
  electionId: string
): Promise<CryptoKey> {
  const signature = await signer.signMessage(
    `Saffra identity backup encryption, election ${electionId}`
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(signature)
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function persistIdentity(
  signer: ethers.Signer,
  electionId: string,
  identity: LocalSemaphoreIdentity
): Promise<void> {
  const key = await identityStorageKey(signer, electionId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(identity.exportedSecret)
  );
  localStorage.setItem(
    `saffra:identity:${electionId}`,
    JSON.stringify({
      version: 1,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      derivationMode: identity.derivationMode,
    })
  );
}

export async function restoreStoredIdentity(
  signer: ethers.Signer,
  electionId: string
): Promise<LocalSemaphoreIdentity | null> {
  const raw = localStorage.getItem(`saffra:identity:${electionId}`);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as {
      version: number;
      iv: string;
      ciphertext: string;
      derivationMode: "deterministic" | "random";
    };
    if (stored.version !== 1) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(base64ToBytes(stored.iv)) },
      await identityStorageKey(signer, electionId),
      asArrayBuffer(base64ToBytes(stored.ciphertext))
    );
    const identity = Identity.import(
      new TextDecoder().decode(new Uint8Array(plaintext))
    );
    return {
      commitment: identity.commitment.toString(),
      exportedSecret: identity.export(),
      derivationMode: stored.derivationMode,
      identityInstance: identity,
    };
  } catch {
    return null;
  }
}

export async function fetchOnChainGroupMembers(
  contractAddress: string,
  fallbackProvider?: ethers.Provider
): Promise<string[]> {
  // Utiliser le RPC public local : le provider injecté par Web3Auth ne
  // supporte pas eth_getLogs sur une chaîne privée (réponse malformée).
  const rpcUrl =
    (import.meta.env.VITE_RPC_URL as string | undefined) ??
    (import.meta.env.VITE_HARDHAT_RPC_URL as string | undefined);
  const provider = rpcUrl
    ? new ethers.JsonRpcProvider(rpcUrl)
    : (fallbackProvider ?? null);
  if (!provider) {
    throw new Error(
      "Aucun RPC disponible pour lire les membres on-chain. Définissez VITE_RPC_URL."
    );
  }
  const contract = new ethers.Contract(contractAddress, votingAbi, provider);
  const events = await contract.queryFilter(contract.filters.VoterRegistered());
  return events
    .map((event) => {
      if (!("args" in event) || !event.args) return null;
      return String(event.args[0]);
    })
    .filter((commitment): commitment is string => commitment !== null);
}

export async function buildSemaphoreVoteProof(params: {
  identity: LocalSemaphoreIdentity;
  groupMembers: string[];
  candidateId: number;
  groupId: string;
  onStep: (label: string, percent: number) => void;
}): Promise<SemaphoreProofPayload> {
  const { identity, groupMembers, candidateId, groupId, onStep } = params;
  onStep("Reconstruction locale de l'arbre de Merkle on-chain...", 25);

  const group = new Group(groupMembers.map((member) => BigInt(member)));
  if (group.indexOf(identity.identityInstance.commitment) === -1) {
    throw new Error(
      "Votre identity commitment n'est pas encore présent dans l'arbre de Merkle."
    );
  }

  onStep("Génération de la preuve ZK locale (WASM + zkey)...", 55);
  const proof = await generateProof(
    identity.identityInstance,
    group,
    candidateId.toString(),
    groupId,
    20,
    {
      wasm: "/artifacts/semaphore-20.wasm",
      zkey: "/artifacts/semaphore-20.zkey",
    }
  );

  onStep("Preuve ZK prête pour soumission anonyme.", 100);
  return {
    merkleTreeDepth: proof.merkleTreeDepth,
    merkleTreeRoot: String(proof.merkleTreeRoot),
    nullifier: String(proof.nullifier),
    message: String(proof.message),
    scope: String(proof.scope),
    points: proof.points.map(String),
  };
}
