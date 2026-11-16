import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import type {
  Election,
  ElectionPhase,
  EligibilityStatus,
  PageRoute,
  SemaphoreProofPayload,
  VoteReceipt,
  Web3AuthSession,
} from "../types/voting";
import type { LocalSemaphoreIdentity } from "../services/semaphoreService";
import {
  deriveIdentityFromSigner,
  restoreStoredIdentity,
} from "../services/semaphoreService";
import {
  authenticateWeb3AuthDemo,
  createDeterministicReceipt,
  createInitialPlatformState,
  evaluateEligibility,
  shuffleArray,
} from "../services/votingBackend";
import {
  checkSupabaseEligibility,
  registerStudentForElection,
} from "../services/eligibilityService";
import {
  submitVoteDirect,
  submitVoteToRelayer,
} from "../services/voteSubmissionService";
import { loadElectionCatalog } from "../services/onChainCatalog";
import {
  connectWeb3Auth,
  disconnectWeb3Auth,
} from "../services/web3AuthService";
import votingAbi from "../abi/VotingABI.json";

const SHUFFLED_BATCH_SIZE = 5;
const SHUFFLED_BATCH_INTERVAL_MS = 30_000;

interface VotingContextValue {
  route: PageRoute;
  navigate: (next: PageRoute) => void;
  session: Web3AuthSession | null;
  isAuthModalOpen: boolean;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  loginWithWeb3Auth: (
    email: string,
    providerLabel: Web3AuthSession["providerLabel"]
  ) => Promise<Web3AuthSession>;
  logout: () => void;
  elections: Election[];
  activeElectionId: string;
  setActiveElectionId: (id: string) => void;
  activeElection: Election;
  identitiesByElection: Record<string, LocalSemaphoreIdentity>;
  setElectionIdentity: (electionId: string, identity: LocalSemaphoreIdentity) => void;
  getEligibility: (electionId: string) => EligibilityStatus | null;
  registerCommitment: (
    electionId: string,
    commitment: string
  ) => Promise<{ queuedCount: number; flushed: boolean }>;
  flushShuffledBatch: (electionId: string) => number;
  castVote: (params: {
    electionId: string;
    candidateId: number;
    proof: SemaphoreProofPayload;
    viaRelayer: boolean;
  }) => Promise<VoteReceipt>;
  relayerOnline: boolean;
  setRelayerOnline: (online: boolean) => void;
  setElectionPhase: (electionId: string, phase: ElectionPhase) => void;
  createElection: (payload: {
    title: string;
    description: string;
    eligibleCount: number;
    candidates: { name: string; department: string; program: string }[];
  }) => Promise<Election>;
  receiptsByElection: Record<string, VoteReceipt>;
}

const VotingContext = createContext<VotingContextValue | null>(null);

function parseRouteFromHash(): PageRoute {
  const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  if (hash === "elections" || hash === "results" || hash === "about" || hash === "admin") {
    return hash;
  }
  return "home";
}

export function VotingProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<PageRoute>(() => parseRouteFromHash());
  const [session, setSession] = useState<Web3AuthSession | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const [initialSeed] = useState(() => createInitialPlatformState());
  const [elections, setElections] = useState<Election[]>(initialSeed.elections);
  const [activeElectionId, setActiveElectionId] = useState<string>("1");
  const catalogSourceRef = useRef<"chain" | "demo">("demo");
  const [identitiesByElection, setIdentitiesByElection] = useState<
    Record<string, LocalSemaphoreIdentity>
  >({});
  const [receiptsByElection, setReceiptsByElection] = useState<
    Record<string, VoteReceipt>
  >({});
  const [relayerOnline, setRelayerOnline] = useState(true);
  const [eligibilityByElection, setEligibilityByElection] = useState<
    Record<string, EligibilityStatus>
  >({});

  // ── Chargement du catalogue réel on-chain au démarrage ──
  // Interroge le backend (GET /elections) puis lit chaque contrat Voting
  // via le RPC : titre, candidats, votes réels, membres et historique.
  // En cas d'échec (nœud absent, backend indisponible) → fallback démo.
  useEffect(() => {
    let mounted = true;
    async function bootstrapCatalog() {
      const onChainElections = await loadElectionCatalog();
      if (!mounted) return;
      if (onChainElections) {
        setElections(onChainElections);
        catalogSourceRef.current = "chain";
        // Ne pas écraser une élection créée localement pendant le chargement
        setActiveElectionId((prev) =>
          onChainElections.some((e) => e.id === prev) ? prev : onChainElections[0].id
        );
        return;
      }
      // Mode démo : seed le compte étudiant démo dans l'élection #1
      const aminaSession = authenticateWeb3AuthDemo(
        "amina.benali@univ-saffra.edu",
        "Google University SSO"
      );
      const aminaId = await deriveIdentityFromSigner(aminaSession.signer, "1");
      if (!mounted) return;
      setElections((prev) =>
        prev.map((el) => {
          if (el.id !== "1") return el;
          if (el.members.includes(aminaId.commitment)) return el;
          return {
            ...el,
            members: [...el.members, aminaId.commitment],
          };
        })
      );
    }
    void bootstrapCatalog();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElections((prev) =>
        prev.map((election) => {
          if (
            election.phase !== "registration" ||
            election.queuedCommitments.length === 0
          ) {
            return election;
          }

          return {
            ...election,
            members: [
              ...election.members,
              ...shuffleArray(election.queuedCommitments),
            ],
            queuedCommitments: [],
          };
        })
      );
    }, SHUFFLED_BATCH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  // ── Écoute on-chain des événements VoteEmis (plan technique §8) ──
  // S'abonne aux événements de chaque contrat Voting déployé.
  // Dès qu'un VoteEmis arrive depuis la blockchain, le compteur et le journal
  // sont mis à jour sans rechargement de page, pour tous les observateurs.
  const onChainListenersRef = useRef<Map<string, ethers.Contract>>(new Map());

  const syncOnChainVote = useCallback(
    (electionId: string, candidateId: bigint, nullifier: bigint, txHash: string) => {
      setElections((prev) =>
        prev.map((el) => {
          if (el.id !== electionId) return el;
          // Dédupliquer : ignorer si ce nullifier est déjà connu (vote soumis par cet onglet)
          const nullifierStr = nullifier.toString();
          if (el.usedNullifiers.includes(nullifierStr)) return el;
          const idx = Number(candidateId);
          const nextVotes = [...el.votes];
          nextVotes[idx] = (nextVotes[idx] || 0) + 1;
          const candidateName = el.candidates[idx]?.name ?? `Candidat #${idx}`;
          return {
            ...el,
            votes: nextVotes,
            usedNullifiers: [...el.usedNullifiers, nullifierStr],
            events: [
              {
                nullifier: nullifierStr,
                candidateId: idx,
                candidateName,
                txHash,
                timestamp: new Date().toLocaleTimeString("fr-FR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }),
                viaRelayer: true, // on ne peut pas le savoir depuis l'événement on-chain
              },
              ...el.events,
            ],
          };
        })
      );
    },
    []
  );

  useEffect(() => {
    const rpcUrl =
      (import.meta.env.VITE_RPC_URL as string | undefined) ??
      (import.meta.env.VITE_HARDHAT_RPC_URL as string | undefined);
    if (!rpcUrl) return; // Pas de RPC configuré → on reste en mode démo in-memory

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const listenersMap = onChainListenersRef.current;

    // Abonner chaque élection dont le contrat est une adresse réelle (non simulée)
    for (const election of elections) {
      if (listenersMap.has(election.id)) continue; // déjà abonné

      const isRealAddress =
        election.contractAddress.startsWith("0x") &&
        election.contractAddress.length === 42;
      if (!isRealAddress) continue;

      const contract = new ethers.Contract(
        election.contractAddress,
        votingAbi,
        provider
      );

      const handler = (nullifier: bigint, candidateId: bigint, event: ethers.EventLog) => {
        syncOnChainVote(election.id, candidateId, nullifier, event.transactionHash);
      };

      contract.on("VoteEmis", handler);
      listenersMap.set(election.id, contract);
    }

    // Nettoyage : désabonner les contrats qui n'existent plus
    return () => {
      for (const [id, contract] of listenersMap.entries()) {
        if (!elections.find((e) => e.id === id)) {
          contract.removeAllListeners("VoteEmis");
          listenersMap.delete(id);
        }
      }
    };
  }, [elections, syncOnChainVote]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRouteFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function navigate(next: PageRoute) {
    setRoute(next);
    window.location.hash = next === "home" ? "/" : `/${next}`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function loginWithWeb3Auth(
    email: string,
    providerLabel: Web3AuthSession["providerLabel"]
  ): Promise<Web3AuthSession> {
    const hasWeb3AuthClientId = Boolean(
      import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined
    );
    const hasApiUrl = Boolean(
      import.meta.env.VITE_API_URL as string | undefined
    );

    let nextSession: Web3AuthSession;

    if (hasWeb3AuthClientId && hasApiUrl) {
      // ── Mode production : vraie connexion Web3Auth + vérification backend ──
      const auth = await connectWeb3Auth();
      if (!auth.email) {
        throw new Error("Web3Auth n'a pas fourni d'adresse email.");
      }
      const apiUrl = (import.meta.env.VITE_API_URL as string).replace(/\/+$/, "");
      const verifiedResponse = await fetch(`${apiUrl}/auth/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.idToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!verifiedResponse.ok) {
        throw new Error("Le backend a refusé le token Web3Auth.");
      }
      const verifiedData = (await verifiedResponse.json()) as {
        studentId?: string;
      };
      nextSession = {
        email: auth.email.toLowerCase(),
        fullName: auth.fullName || auth.email,
        studentId: verifiedData.studentId || "",
        address: auth.address,
        idToken: auth.idToken,
        providerLabel,
        signer: auth.signer,
      };
    } else {
      // ── Mode démo local : wallet dérivé déterministiquement, pas de réseau ──
      nextSession = authenticateWeb3AuthDemo(email, providerLabel);
    }

    // Eligibilité : via backend si disponible, sinon Supabase direct ou évaluation locale
    let eligibility: EligibilityStatus;
    try {
      eligibility = await checkSupabaseEligibility(
        nextSession.email,
        activeElectionId,
        nextSession.idToken
      );
    } catch {
      // Pas de backend/Supabase configuré → évaluation locale sur les étudiants démo
      eligibility = evaluateEligibility(nextSession.email, activeElectionId, {});
    }

    setSession(nextSession);

    // Restaurer l'identité Semaphore chiffrée en localStorage, ou la dériver
    const storedIdentity = await restoreStoredIdentity(
      nextSession.signer,
      activeElectionId
    ).catch(() => null);
    const recoveredIdentity =
      storedIdentity ||
      (await deriveIdentityFromSigner(nextSession.signer, activeElectionId));

    setIdentitiesByElection((prev) => ({
      ...prev,
      [activeElectionId]: recoveredIdentity,
    }));
    setEligibilityByElection({ [activeElectionId]: eligibility });
    setIsAuthModalOpen(false);
    return nextSession;
  }

  function logout() {
    void disconnectWeb3Auth();
    setSession(null);
    setIdentitiesByElection({});
    setEligibilityByElection({});
  }

  function setElectionIdentity(
    electionId: string,
    identity: LocalSemaphoreIdentity
  ) {
    setIdentitiesByElection((prev) => ({
      ...prev,
      [electionId]: identity,
    }));
  }

  function getEligibility(electionId: string): EligibilityStatus | null {
    if (!session) return null;
    return eligibilityByElection[electionId] || null;
  }

  async function registerCommitment(
    electionId: string,
    commitment: string
  ): Promise<{ queuedCount: number; flushed: boolean }> {
    if (!session) {
      throw new Error("Authentification Web3Auth requise.");
    }

    const target = elections.find((e) => e.id === electionId);
    if (!target) throw new Error("Élection introuvable.");

    if (target.phase !== "registration") {
      throw new Error("Revert: Registration closed (le scrutin a déjà démarré).");
    }

    const status = await checkSupabaseEligibility(
      session.email,
      electionId,
      session.idToken
    );
    setEligibilityByElection((prev) => ({ ...prev, [electionId]: status }));
    if (status === "not_on_list") {
      throw new Error("Étudiant non présent sur la liste électorale universitaire.");
    }
    // already_registered n'est PAS bloquant ici : si le commitment n'est pas
    // encore on-chain (file perdue, flush échoué...), le backend le remet
    // en file et renvoie "queued". C'est lui qui tranche définitivement.

    if (target.members.length + target.queuedCommitments.length >= target.eligibleCount) {
      throw new Error(
        "Nombre maximum de commitments atteint par rapport au registre officiel."
      );
    }

    const registrationResult = await registerStudentForElection(
      session.email,
      electionId,
      commitment,
      session.idToken
    );
    if (registrationResult === "not_on_list") {
      throw new Error("Étudiant non présent sur la liste électorale universitaire.");
    }
    if (registrationResult === "already_registered") {
      setEligibilityByElection((prev) => ({
        ...prev,
        [electionId]: "already_registered",
      }));
      throw new Error("Le backend refuse la seconde inscription pour cet étudiant.");
    }
    setEligibilityByElection((prev) => ({
      ...prev,
      [electionId]: "already_registered",
    }));

    // Anti-timing correlation mitigation (§7.1): queue and flush in shuffled batch
    const updatedQueue = [...target.queuedCommitments, commitment];
    const shouldAutoFlush = updatedQueue.length >= SHUFFLED_BATCH_SIZE;
    const flushedMembers = shouldAutoFlush
      ? shuffleArray(updatedQueue)
      : [];

    setElections((prev) =>
      prev.map((el) => {
        if (el.id !== electionId) return el;
        return {
          ...el,
          members: shouldAutoFlush
            ? [...el.members, ...flushedMembers]
            : el.members,
          queuedCommitments: shouldAutoFlush ? [] : updatedQueue,
        };
      })
    );

    return {
      queuedCount: shouldAutoFlush ? 0 : updatedQueue.length,
      flushed: shouldAutoFlush,
    };
  }

  function flushShuffledBatch(electionId: string): number {
    let count = 0;
    setElections((prev) =>
      prev.map((el) => {
        if (el.id !== electionId || el.queuedCommitments.length === 0) return el;
        count = el.queuedCommitments.length;
        return {
          ...el,
          members: [...el.members, ...shuffleArray(el.queuedCommitments)],
          queuedCommitments: [],
        };
      })
    );
    return count;
  }

  async function castVote(params: {
    electionId: string;
    candidateId: number;
    proof: SemaphoreProofPayload;
    viaRelayer: boolean;
  }): Promise<VoteReceipt> {
    const { electionId, candidateId, proof, viaRelayer } = params;
    const target = elections.find((e) => e.id === electionId);
    if (!target) throw new Error("Élection introuvable.");

    if (viaRelayer && !relayerOnline) {
      throw new Error(
        "Relayer temporairement indisponible. Utilisez la soumission directe on-chain (Fallback)."
      );
    }

    if (target.phase !== "voting") {
      throw new Error("Revert: Election not open.");
    }

    if (candidateId < 0 || candidateId >= target.candidates.length) {
      throw new Error("Revert: Invalid candidate.");
    }

    if (proof.message !== candidateId.toString()) {
      throw new Error("Revert: Message mismatch.");
    }

    if (proof.scope !== target.groupId) {
      throw new Error("Revert: Wrong scope.");
    }

    if (target.usedNullifiers.includes(proof.nullifier)) {
      throw new Error(
        "Revert on reused nullifier : un vote a déjà été enregistré avec ce nullifier."
      );
    }

    const submission = viaRelayer
      ? await submitVoteToRelayer({
          electionId,
          candidateId,
          proof,
        })
      : await submitVoteDirect({
          contractAddress: target.contractAddress,
          candidateId,
          proof,
          signer: session!.signer,
        });
    const receipt = {
      ...createDeterministicReceipt(candidateId, proof, viaRelayer),
      txHash: submission.txHash,
    };
    const candidateName =
      target.candidates[candidateId]?.name || `Candidat #${candidateId}`;

    setElections((prev) =>
      prev.map((el) => {
        if (el.id !== electionId) return el;
        const nextVotes = [...el.votes];
        nextVotes[candidateId] = (nextVotes[candidateId] || 0) + 1;
        return {
          ...el,
          votes: nextVotes,
          usedNullifiers: [...el.usedNullifiers, proof.nullifier],
          events: [
            {
              nullifier: proof.nullifier,
              candidateId,
              candidateName,
              txHash: receipt.txHash,
              timestamp: receipt.timestamp,
              viaRelayer,
            },
            ...el.events,
          ],
        };
      })
    );

    setReceiptsByElection((prev) => ({
      ...prev,
      [electionId]: receipt,
    }));

    return receipt;
  }

  function setElectionPhase(electionId: string, phase: ElectionPhase) {
    setElections((prev) =>
      prev.map((el) => {
        if (el.id !== electionId) return el;
        if (phase === "registration" || el.queuedCommitments.length === 0) {
          return { ...el, phase };
        }

        return {
          ...el,
          phase,
          members: [...el.members, ...shuffleArray(el.queuedCommitments)],
          queuedCommitments: [],
        };
      })
    );
  }

  async function createElection(payload: {
    title: string;
    description: string;
    eligibleCount: number;
    candidates: { name: string; department: string; program: string }[];
  }): Promise<Election> {
    const nextId = String(elections.length + 1);
    const now = Math.floor(Date.now() / 1000);
    const startTime = now ;
    const endTime = now + 86400;

    const candidateNames = payload.candidates.map((c) => c.name);

    // ── Tentative de déploiement réel via le backend admin ──
    const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
    let contractAddress: string | null = null;
    let groupId: string | null = null;

    if (apiUrl && session?.idToken) {
      try {
        const response = await fetch(
          `${apiUrl.replace(/\/+$/, "")}/admin/elections`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.idToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              electionId: nextId,
              title: payload.title,
              candidates: candidateNames,
              startTime,
              endTime,
            }),
          }
        );
        if (response.ok) {
          const data = (await response.json()) as {
            contractAddress?: string;
            groupId?: string;
          };
          contractAddress = data.contractAddress ?? null;
          // groupId est retourné par le backend si disponible
          groupId = data.groupId ?? null;
        }
      } catch {
        // Backend non disponible → mode démo local (pas de déploiement réel)
      }
    }

    // ── Fallback démo : adresse déterministe locale ──
    if (!contractAddress) {
      contractAddress = ethers.getCreateAddress({
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        nonce: elections.length + 10,
      });
    }
    if (!groupId) {
      groupId = String(100 + elections.length + 1);
    }

    const created: Election = {
      id: nextId,
      groupId,
      contractAddress,
      title: payload.title,
      description: payload.description,
      phase: "registration",
      startTime,
      endTime,
      eligibleCount: payload.eligibleCount,
      candidates: payload.candidates.map((c, idx) => ({
        id: idx,
        name: c.name,
        department: c.department,
        program: c.program,
      })),
      members: [],
      queuedCommitments: [],
      votes: payload.candidates.map(() => 0),
      usedNullifiers: [],
      events: [],
    };

    setElections((prev) => [...prev, created]);
    setActiveElectionId(nextId);
    return created;
  }

  const activeElection =
    elections.find((e) => e.id === activeElectionId) || elections[0];

  return (
    <VotingContext.Provider
      value={{
        route,
        navigate,
        session,
        isAuthModalOpen,
        openAuthModal: () => setIsAuthModalOpen(true),
        closeAuthModal: () => setIsAuthModalOpen(false),
        loginWithWeb3Auth,
        logout,
        elections,
        activeElectionId,
        setActiveElectionId,
        activeElection,
        identitiesByElection,
        setElectionIdentity,
        getEligibility,
        registerCommitment,
        flushShuffledBatch,
        castVote,
        relayerOnline,
        setRelayerOnline,
        setElectionPhase,
        createElection,
        receiptsByElection,
      }}
    >
      {children}
    </VotingContext.Provider>
  );
}

export function useVoting() {
  const ctx = useContext(VotingContext);
  if (!ctx) {
    throw new Error("useVoting must be used within VotingProvider");
  }
  return ctx;
}
