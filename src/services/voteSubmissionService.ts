import { ethers } from "ethers";
import votingAbi from "../abi/VotingABI.json";
import type { SemaphoreProofPayload } from "../types/voting";

export interface VoteSubmission {
  txHash: string;
}

function getRelayerUrl(): string {
  const url = import.meta.env.VITE_RELAYER_URL as string | undefined;
  if (!url) {
    throw new Error(
      "Relayer non configuré. Définissez VITE_RELAYER_URL ou activez le fallback direct."
    );
  }
  return url.replace(/\/+$/, "");
}

export async function submitVoteToRelayer(params: {
  electionId: string;
  candidateId: number;
  proof: SemaphoreProofPayload;
  idToken: string;
}): Promise<VoteSubmission> {
  const response = await fetch(`${getRelayerUrl()}/vote`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      electionId: params.electionId,
      candidateId: params.candidateId,
      proof: params.proof,
    }),
  });

  if (!response.ok) {
    throw new Error(`Le relayer a refusé le vote (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as { txHash?: string };
  if (!payload.txHash) {
    throw new Error("Réponse invalide du relayer : txHash manquant.");
  }

  return { txHash: payload.txHash };
}

export async function submitVoteDirect(params: {
  contractAddress: string;
  candidateId: number;
  proof: SemaphoreProofPayload;
  signer: ethers.Signer;
}): Promise<VoteSubmission> {
  const contract = new ethers.Contract(
    params.contractAddress,
    votingAbi,
    params.signer
  );
  const transaction = await contract.vote(params.candidateId, {
    merkleTreeDepth: params.proof.merkleTreeDepth,
    merkleTreeRoot: params.proof.merkleTreeRoot,
    nullifier: params.proof.nullifier,
    message: params.proof.message,
    scope: params.proof.scope,
    points: params.proof.points,
  });
  const receipt = await transaction.wait();

  if (!receipt?.hash) {
    throw new Error("La transaction directe n'a pas produit de reçu.");
  }

  return { txHash: receipt.hash };
}
