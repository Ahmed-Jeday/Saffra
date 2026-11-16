import { network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const { viem } = await network.create({ network: "localhost" });

// ── 1. Déploiement Semaphore (Poseidon + Verifier + Semaphore) ──
const poseidon = await viem.deployContract("PoseidonT3");
console.log("PoseidonT3 deployed at:", poseidon.address);

const verifier = await viem.deployContract("SemaphoreVerifier");
console.log("SemaphoreVerifier deployed at:", verifier.address);

const semaphore = await viem.deployContract("Semaphore", [verifier.address], {
  libraries: {
    PoseidonT3: poseidon.address,
  },
});
console.log("Semaphore deployed at:", semaphore.address);

// ── 2. Déploiement du contrat Voting (élection #1) ──
// Fenêtre : 30 min d'inscription, puis 24 h de vote.
const now = Math.floor(Date.now() / 1000);
const startTime = now + 200;
const endTime = startTime + 60 * 60 * 24;

const [deployer] = await viem.getWalletClients();

const voting = await viem.deployContract("Voting", [
  semaphore.address,
  "Élection des Délégués Étudiants 2026",
  ["Liste Horizon Campus", "Collectif Avenir Solidaire", "Alliance Tech & Culture"],
  BigInt(startTime),
  BigInt(endTime),
  deployer.account.address, // registrar = compte #0 (REGISTRAR_PRIVATE_KEY)
]);
console.log("Voting (ELECTION_1_CONTRACT) deployed at:", voting.address);
console.log("registrar:", deployer.account.address);

// ── 3. Écriture automatique des adresses dans le .env racine ──
const envPath = path.resolve(import.meta.dirname, "..", "..", ".env");

function upsertEnvLine(key: string, value: string): void {
  let content = readFileSync(envPath, "utf8");
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^#?\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content = `${content.replace(/\s*$/, "\n")}${line}\n`;
  }
  writeFileSync(envPath, content, "utf8");
}

upsertEnvLine("SEMAPHORE_ADDRESS", semaphore.address);
upsertEnvLine("ELECTION_1_CONTRACT", voting.address);
console.log(`\n✅ .env mis à jour : ${envPath}`);
console.log(
  `ℹ️  L'urne ouvre à ${new Date(startTime * 1000).toLocaleTimeString("fr-FR")} (inscription pendant 30 min).`
);
console.log("ℹ️  Redémarrez le backend (npm run server) pour recharger le .env.");
