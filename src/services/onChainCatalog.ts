import { ethers } from "ethers";
import votingAbi from "../abi/VotingABI.json";
import type { Election, ElectionPhase } from "../types/voting";

export interface BackendElectionRef {
  electionId: string;
  address: string;
}

function getApiUrl(): string | null {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  return url ? url.replace(/\/+$/, "") : null;
}

function getRpcUrl(): string | null {
  const url =
    (import.meta.env.VITE_RPC_URL as string | undefined) ??
    (import.meta.env.VITE_HARDHAT_RPC_URL as string | undefined);
  return url ?? null;
}

/**
 * Demande au backend le catalogue des contrats Voting déployés.
 * Retourne null si le backend n'est pas configuré ou indisponible.
 */
export async function fetchElectionRefs(): Promise<BackendElectionRef[] | null> {
  const apiUrl = getApiUrl();
  if (!apiUrl) return null;
  try {
    const response = await fetch(`${apiUrl}/elections`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as BackendElectionRef[];
    if (!Array.isArray(payload) || payload.length === 0) return null;
    return payload;
  } catch {
    return null;
  }
}

function phaseFor(
  nowSeconds: number,
  startTime: number,
  endTime: number
): ElectionPhase {
  if (nowSeconds < startTime) return "registration";
  if (nowSeconds <= endTime) return "voting";
  return "closed";
}

/**
 * Lit l'état complet d'une élection directement on-chain :
 * titre, candidats, votes réels, période, groupId, membres (événements
 * VoterRegistered) et historique des votes (événements VoteEmis).
 */
export async function loadElectionFromChain(
  ref: BackendElectionRef,
  provider: ethers.Provider
): Promise<Election | null> {
  try {
    const contract = new ethers.Contract(ref.address, votingAbi, provider);

    const [title, groupIdRaw, startTimeRaw, endTimeRaw, countRaw] =
      await Promise.all([
        contract.title(),
        contract.groupId(),
        contract.startTime(),
        contract.endTime(),
        contract.candidatesCount(),
      ]);

    const candidateCount = Number(countRaw);
    if (candidateCount === 0) return null;

    const [candidateNames, voteCounts] = await Promise.all([
      Promise.all(
        Array.from({ length: candidateCount }, (_, i) => contract.candidates(i))
      ),
      Promise.all(
        Array.from({ length: candidateCount }, (_, i) => contract.votes(i))
      ),
    ]);

    const startTime = Number(startTimeRaw);
    const endTime = Number(endTimeRaw);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const phase = phaseFor(nowSeconds, startTime, endTime);

    // Membres réels du groupe : événements VoterRegistered
    const registrationEvents = await contract.queryFilter(
      contract.filters.VoterRegistered()
    );
    const members: string[] = [];
    for (const event of registrationEvents) {
      const commitment = (event as ethers.EventLog).args?.[0];
      if (commitment !== undefined) members.push(commitment.toString());
    }

    // Historique réel des votes : événements VoteEmis
    const voteEvents = await contract.queryFilter(
      contract.filters.VoteEmis()
    );
    const usedNullifiers: string[] = [];
    const events: Election["events"] = [];
    for (const event of [...voteEvents].reverse()) {
      const log = event as ethers.EventLog;
      const nullifier = log.args?.[0]?.toString();
      const candidateId = Number(log.args?.[1]);
      const block = await event.getBlock();
      if (nullifier) usedNullifiers.push(nullifier);
      events.push({
        nullifier: nullifier ?? "",
        candidateId,
        candidateName:
          candidateNames[candidateId] ?? `Candidat #${candidateId}`,
        txHash: log.transactionHash,
        timestamp: new Date(block.timestamp * 1000).toLocaleTimeString(
          "fr-FR",
          { hour: "2-digit", minute: "2-digit", second: "2-digit" }
        ),
        viaRelayer: true,
      });
    }

    const election: Election = {
      id: ref.electionId,
      groupId: groupIdRaw.toString(),
      contractAddress: ref.address,
      title,
      description:
        "Scrutin on-chain : état lu directement depuis le contrat Voting déployé.",
      phase,
      startTime,
      endTime,
      eligibleCount: Math.max(members.length, 1),
      candidates: candidateNames.map((name, idx) => ({
        id: idx,
        name,
        department: "",
        program: "",
      })),
      members,
      queuedCommitments: [],
      votes: voteCounts.map((v: bigint) => Number(v)),
      usedNullifiers,
      events,
    };
    return election;
  } catch {
    return null;
  }
}

/**
 * Charge tout le catalogue on-chain. Retourne null si aucune élection
 * n'a pu être lue (nœud absent, contrat inaccessible...).
 */
export async function loadElectionCatalog(): Promise<Election[] | null> {
  const rpcUrl = getRpcUrl();
  if (!rpcUrl) return null;

  const refs = await fetchElectionRefs();
  if (!refs) return null;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const results = await Promise.all(
    refs.map((ref) => loadElectionFromChain(ref, provider))
  );
  const elections = results.filter((e): e is Election => e !== null);
  return elections.length > 0 ? elections : null;
}
