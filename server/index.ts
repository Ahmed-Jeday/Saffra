import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

interface AuthenticatedRequest extends Request {
  user?: JWTPayload & { email?: string };
}

interface QueuedCommitment {
  commitment: string;
  electionId: string;
}

const app = express();
app.use((request, response, next) => {
  const origin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
  response.header("Access-Control-Allow-Origin", origin);
  response.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: "32kb" }));

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante: ${name}`);
  return value;
};

const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
const supabaseKey = required("SUPABASE_SERVICE_ROLE_KEY");
const web3AuthIssuer = required("WEB3AUTH_ISSUER");
const web3AuthClientId = required("WEB3AUTH_CLIENT_ID");
const jwks = createRemoteJWKSet(
  new URL(`${web3AuthIssuer.replace(/\/+$/, "")}/.well-known/jwks.json`)
);
const queue = new Map<string, QueuedCommitment[]>();
const batchSize = Number(process.env.REGISTRATION_BATCH_SIZE ?? 5);
const batchIntervalMs = Number(
  process.env.REGISTRATION_BATCH_INTERVAL_MS ?? 30_000
);

function bearerToken(request: Request): string {
  const value = request.header("authorization");
  if (!value?.startsWith("Bearer ")) throw new Error("Authorization Bearer requis.");
  return value.slice("Bearer ".length);
}

async function verifyToken(token: string) {
  const result = await jwtVerify(token, jwks, {
    issuer: web3AuthIssuer,
    audience: web3AuthClientId,
  });
  if (typeof result.payload.email !== "string") {
    throw new Error("Le token Web3Auth ne contient pas d'email.");
  }
  return result.payload as JWTPayload & { email: string };
}

async function authenticate(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
) {
  try {
    request.user = await verifyToken(bearerToken(request));
    next();
  } catch {
    response.status(401).json({ error: "Token Web3Auth invalide ou expiré." });
  }
}

async function supabase<T>(
  resource: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function studentIdFor(email: string): Promise<string | null> {
  const rows = await supabase<{ id: string }[]>(
    `etudiants?select=id&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  return rows[0]?.id ?? null;
}

async function eligibilityFor(email: string, electionId: string) {
  const studentId = await studentIdFor(email);
  if (!studentId) return { status: "not_on_list" as const };
  const rows = await supabase<
    { is_eligible: boolean; is_registered: boolean }[]
  >(
    `inscriptions_vote?select=is_eligible,is_registered&etudiant_id=eq.${studentId}&election_id=eq.${encodeURIComponent(
      electionId
    )}&limit=1`
  );
  const registration = rows[0];
  if (registration && !registration.is_eligible) {
    return { status: "not_on_list" as const };
  }
  if (registration?.is_registered) {
    return { status: "already_registered" as const };
  }
  return { status: "eligible" as const };
}

const artifactPath = path.resolve(
  "voting-semaphore",
  "artifacts",
  "contracts",
  "Voting.sol",
  "Voting.json"
);

async function loadArtifact(): Promise<{ abi: ethers.InterfaceAbi; bytecode?: string }> {
  return JSON.parse(readFileSync(artifactPath, "utf8"));
}

// Commitments déjà enregistrés on-chain pour une élection donnée.
async function onChainCommitments(address: string): Promise<Set<string>> {
  const provider = new ethers.JsonRpcProvider(required("RPC_URL"));
  const artifact = await loadArtifact();
  const contract = new ethers.Contract(address, artifact.abi, provider);
  const events = await contract.queryFilter(
    contract.filters.VoterRegistered()
  );
  const commitments = new Set<string>();
  for (const event of events) {
    const arg = (event as ethers.EventLog).args?.[0];
    if (arg !== undefined) commitments.add(arg.toString());
  }
  return commitments;
}

async function flushElection(electionId: string) {
  const pending = queue.get(electionId) ?? [];
  if (pending.length === 0) return 0;
  const provider = new ethers.JsonRpcProvider(required("RPC_URL"));
  const registrar = new ethers.Wallet(
    required("REGISTRAR_PRIVATE_KEY"),
    provider
  );
  const artifact = await loadArtifact() as { abi: ethers.InterfaceAbi };
  const address = required(`ELECTION_${electionId}_CONTRACT`);
  const contract = new ethers.Contract(address, artifact.abi, registrar);
  const shuffled = [...pending].sort(() => Math.random() - 0.5);
  const done: QueuedCommitment[] = [];
  for (const item of shuffled) {
    try {
      await (await contract.registerVoter(item.commitment)).wait();
      done.push(item);
    } catch (error) {
      console.error(
        `registerVoter échoué pour election ${electionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  if (done.length > 0) {
    const remaining = (queue.get(electionId) ?? []).filter(
      (item) => !done.includes(item)
    );
    if (remaining.length > 0) queue.set(electionId, remaining);
    else queue.delete(electionId);
  }
  return done.length;
}

async function registrationState(
  electionId: string,
  safetyWindowMs: number
): Promise<{ open: boolean; closingSoon: boolean }> {
  const address = required(`ELECTION_${electionId}_CONTRACT`);
  const provider = new ethers.JsonRpcProvider(required("RPC_URL"));
  const artifact = await loadArtifact();
  const contract = new ethers.Contract(address, artifact.abi, provider);
  const startTime = Number(await contract.startTime());
  const startMs = startTime * 1000;
  const now = Date.now();
  return {
    open: now < startMs,
    closingSoon: now < startMs && now + safetyWindowMs >= startMs,
  };
}

app.post("/auth/verify", async (request, response) => {
  try {
    const payload = await verifyToken(bearerToken(request));
    const studentId = await studentIdFor(payload.email);
    response.json({ email: payload.email, studentId, authenticated: true });
  } catch {
    response.status(401).json({ error: "Token Web3Auth invalide ou étudiant inconnu." });
  }
});

app.get("/eligibility", authenticate, async (request: AuthenticatedRequest, response) => {
  try {
    const electionId = String(request.query.electionId ?? "");
    if (!electionId || !request.user?.email) {
      response.status(400).json({ error: "electionId requis." });
      return;
    }
    response.json(await eligibilityFor(request.user.email, electionId));
  } catch {
    response.status(500).json({ error: "Vérification d'éligibilité impossible." });
  }
});

app.post("/register", authenticate, async (request: AuthenticatedRequest, response) => {
  try {
    const { electionId, commitment } = request.body as {
      electionId?: string;
      commitment?: string;
    };
    if (!electionId || !commitment || !/^\d+$/.test(commitment)) {
      response.status(400).json({ error: "electionId et commitment valides requis." });
      return;
    }
    const status = await eligibilityFor(request.user!.email!, electionId);
    if (status.status === "not_on_list") {
      response.status(409).json(status);
      return;
    }
    if (status.status === "already_registered") {
      // Reprise : l'étudiant est marqué inscrit en base, mais son commitment
      // n'est peut-être pas encore on-chain (file perdue au redémarrage,
      // flush échoué...). Si absent de la chaîne, on le remet en file.
      try {
        const contractAddress = required(`ELECTION_${electionId}_CONTRACT`);
        const registration = await registrationState(
          electionId,
          batchIntervalMs
        );
        if (!registration.open) {
          response.status(409).json({
            status: "registration_closed",
            error: "La période d'inscription est déjà fermée.",
          });
          return;
        }
        const registered = await onChainCommitments(contractAddress);
        const pending = queue.get(electionId) ?? [];
        const alreadyQueued = pending.some(
          (item) => item.commitment === commitment
        );
        if (registered.has(commitment)) {
          response.status(409).json({ status: "already_registered" });
          return;
        }
        if (alreadyQueued) {
          response.status(202).json({
            status: "queued",
            queuedCount: pending.length,
          });
          return;
        }
        queue.set(electionId, [...pending, { electionId, commitment }]);
        const queuedCount = queue.get(electionId)!.length;
        const registrationAfterQueue = await registrationState(
          electionId,
          batchIntervalMs
        );
        if (
          queuedCount >= batchSize ||
          registrationAfterQueue.closingSoon
        ) {
          await flushElection(electionId);
        }
        response.status(202).json({ status: "queued", queuedCount });
        return;
      } catch (error) {
        console.error(
          "Reprise d'inscription impossible:",
          error instanceof Error ? error.message : error
        );
        response.status(409).json({ status: "already_registered" });
        return;
      }
    }
    const registration = await registrationState(electionId, batchIntervalMs);
    if (!registration.open) {
      response.status(409).json({
        status: "registration_closed",
        error: "La période d'inscription est déjà fermée.",
      });
      return;
    }
    const studentId = await studentIdFor(request.user!.email!);
    const updated = await supabase<unknown[]>(
      `inscriptions_vote?etudiant_id=eq.${studentId}&election_id=eq.${encodeURIComponent(
        electionId
      )}&is_eligible=eq.true&is_registered=eq.false`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ is_registered: true, registered_at: new Date().toISOString() }),
      }
    );
    if (updated.length === 0) {
      response.status(409).json({ status: "already_registered" });
      return;
    }
    const pending = queue.get(electionId) ?? [];
    queue.set(electionId, [...pending, { electionId, commitment }]);
    const queuedCount = queue.get(electionId)!.length;
    const registrationAfterQueue = await registrationState(
      electionId,
      batchIntervalMs
    );
    if (
      queuedCount >= batchSize ||
      registrationAfterQueue.closingSoon
    ) {
      await flushElection(electionId);
    }
    response.status(202).json({ status: "queued", queuedCount });
  } catch {
    response.status(500).json({ error: "Enregistrement impossible." });
  }
});

async function relayVote(
  request: AuthenticatedRequest,
  response: Response
) {
  try {
    const { electionId, candidateId, proof } = request.body as {
      electionId?: string;
      candidateId?: number;
      proof?: Record<string, unknown>;
    };
    if (!electionId || typeof candidateId !== "number" || !proof) {
      response.status(400).json({ error: "electionId, candidateId et proof requis." });
      return;
    }
    const provider = new ethers.JsonRpcProvider(required("RPC_URL"));
    const relayer = new ethers.Wallet(required("RELAYER_PRIVATE_KEY"), provider);
    const artifact = JSON.parse(
      readFileSync(
        path.resolve("voting-semaphore", "artifacts", "contracts", "Voting.sol", "Voting.json"),
        "utf8"
      )
    ) as { abi: ethers.InterfaceAbi };
    const contract = new ethers.Contract(
      required(`ELECTION_${electionId}_CONTRACT`),
      artifact.abi,
      relayer
    );
    const transaction = await contract.vote(candidateId, proof);
    const receipt = await transaction.wait();
    response.json({ txHash: receipt.hash });
  } catch (error) {
    console.error(
      "Relayer: soumission du vote impossible:",
      error instanceof Error ? error.message : error
    );
    response.status(502).json({ error: "Le relayer n'a pas pu soumettre le vote." });
  }
}

app.post("/relay-vote", authenticate, relayVote);
app.post("/vote", authenticate, relayVote);

// Catalogue public des élections déployées : liste les adresses des
// contrats Voting connus du serveur (variables ELECTION_*_CONTRACT).
app.get("/elections", (_request, response) => {
  const elections = Object.entries(process.env)
    .filter(([key]) => /^ELECTION_\w+_CONTRACT$/.test(key))
    .map(([key, value]) => ({
      electionId: key.replace(/^ELECTION_/, "").replace(/_CONTRACT$/, ""),
      address: value,
    }));
  response.json(elections);
});

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "").split(",").map((email) => email.trim());
}

function isAdmin(request: AuthenticatedRequest): boolean {
  return Boolean(request.user?.email && adminEmails().includes(request.user.email));
}

// Persistance d'une variable dans le fichier .env (survit au redémarrage).
function upsertEnvLine(key: string, value: string): void {
  const envPath = path.resolve(".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    content = "";
  }
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^#?\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content = `${content.replace(/\s*$/, "\n")}${line}\n`;
  }
  writeFileSync(envPath, content, "utf8");
}

app.post("/admin/elections", authenticate, async (request: AuthenticatedRequest, response) => {
  try {
    if (!isAdmin(request)) {
      response.status(403).json({ error: "Accès administrateur refusé." });
      return;
    }
    const { title, candidates, startTime, endTime, electionId } = request.body as {
      title?: string;
      candidates?: string[];
      startTime?: number;
      endTime?: number;
      electionId?: string;
    };
    const provider = new ethers.JsonRpcProvider(required("RPC_URL"));
    const deployer = new ethers.Wallet(required("REGISTRAR_PRIVATE_KEY"), provider);
    const artifact = JSON.parse(
      readFileSync(
        path.resolve("voting-semaphore", "artifacts", "contracts", "Voting.sol", "Voting.json"),
        "utf8"
      )
    ) as { abi: ethers.InterfaceAbi; bytecode: string };
    const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(
      required("SEMAPHORE_ADDRESS"),
      title,
      candidates,
      startTime,
      endTime,
      deployer.address
    );
    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();
    const deployed = new ethers.Contract(contractAddress, artifact.abi, provider);
    const groupId = (await deployed.groupId()).toString();
    if (electionId) {
      process.env[`ELECTION_${electionId}_CONTRACT`] = contractAddress;
      try {
        upsertEnvLine(`ELECTION_${electionId}_CONTRACT`, contractAddress);
      } catch (error) {
        console.error(
          "Persistance du .env impossible:",
          error instanceof Error ? error.message : error
        );
      }
    }
    response.status(201).json({ contractAddress, groupId });
  } catch (error) {
    console.error(
      "Déploiement de l'élection impossible:",
      error instanceof Error ? error.message : error
    );
    response.status(500).json({ error: "Déploiement de l'élection impossible." });
  }
});

// Time-travel Hardhat : déplace l'horloge de la chaîne pour réellement
// changer la phase du contrat (block.timestamp), pas seulement l'affichage.
app.post("/admin/time-travel", authenticate, async (request: AuthenticatedRequest, response) => {
  try {
    if (!isAdmin(request)) {
      response.status(403).json({ error: "Accès administrateur refusé." });
      return;
    }
    const { toTimestamp } = request.body as { toTimestamp?: number };
    if (typeof toTimestamp !== "number" || !Number.isFinite(toTimestamp)) {
      response.status(400).json({ error: "toTimestamp (unix seconds) requis." });
      return;
    }
    const provider = new ethers.JsonRpcProvider(required("RPC_URL"));
    const latest = await provider.getBlock("latest");
    const chainNow = latest?.timestamp ?? Math.floor(Date.now() / 1000);
    if (toTimestamp < chainNow) {
      response.status(400).json({
        error:
          "Retour en arrière impossible : Hardhat 3 ne supporte pas evm_setTime. " +
          "L'horloge de la chaîne ne peut qu'avancer (choisissez une phase future).",
      });
      return;
    }
    await provider.send("evm_setNextBlockTimestamp", [Math.ceil(toTimestamp)]);
    await provider.send("evm_mine", []);
    const block = await provider.getBlock("latest");
    response.json({ timestamp: block?.timestamp ?? toTimestamp });
  } catch (error) {
    console.error(
      "Time-travel impossible:",
      error instanceof Error ? error.message : error
    );
    response.status(500).json({ error: "Time-travel impossible sur le nœud RPC." });
  }
});

setInterval(() => {
  for (const electionId of queue.keys()) {
    void registrationState(electionId, batchIntervalMs)
      .then((registration) => {
        if (registration.open) return flushElection(electionId);
        console.error(
          `Inscriptions en attente pour l'élection ${electionId} : la période d'inscription est fermée.`
        );
        return 0;
      })
      .catch((error) => {
        console.error(
          `Vidange de la file impossible pour l'élection ${electionId}:`,
          error instanceof Error ? error.message : error
        );
        return 0;
      });
  }
}, batchIntervalMs);

const port = Number(process.env.API_PORT ?? 3001);
app.listen(port, () => console.log(`API backend listening on port ${port}`));
