import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const abi = JSON.parse(readFileSync("src/abi/VotingABI.json", "utf8")) as ethers.InterfaceAbi;
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const contract = new ethers.Contract("0x0165878a594ca255338adfa4d48449f69242eb8f", abi, provider);

const [title, groupId, startTime, endTime, count] = await Promise.all([
  contract.title(),
  contract.groupId(),
  contract.startTime(),
  contract.endTime(),
  contract.candidatesCount(),
]);
console.log("title:", title);
console.log("groupId:", groupId.toString());
console.log("startTime:", Number(startTime), "| endTime:", Number(endTime));

const n = Number(count);
console.log("candidatesCount:", n);
const names = await Promise.all(Array.from({ length: n }, (_, i) => contract.candidates(i)));
console.log("candidates:", names);
const votes = await Promise.all(Array.from({ length: n }, (_, i) => contract.votes(i)));
console.log("votes:", votes.map((v: bigint) => Number(v)));

const registrations = await contract.queryFilter(contract.filters.VoterRegistered());
console.log("members (VoterRegistered):", registrations.length);

const voteEvents = await contract.queryFilter(contract.filters.VoteEmis());
console.log("vote events (VoteEmis):", voteEvents.length);
