import { network } from "hardhat";

const { viem } = await network.create({ network: "localhost" });

const SEMAPHORE_ADDRESS =
  (process.env.SEMAPHORE_ADDRESS ?? "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707") as `0x${string}`;

const now = Math.floor(Date.now() / 1000);
const startTime = now + 60 * 60 * 2; // inscription encore ouverte 2h
const endTime = now + 60 * 60 * 30; // urne ouverte 30h

const [deployer] = await viem.getWalletClients();

const voting = await viem.deployContract("Voting", [
  SEMAPHORE_ADDRESS,
  "Élection des Délégués Étudiants 2026",
  [
    "Liste Horizon Campus",
    "Collectif Avenir Solidaire",
    "Alliance Tech & Culture",
  ],
  BigInt(startTime),
  BigInt(endTime),
  deployer.account.address, // registrar = compte #0 (REGISTRAR_PRIVATE_KEY)
]);

console.log("Voting (ELECTION_1_CONTRACT) deployed at:", voting.address);
console.log("registrar:", deployer.account.address);
