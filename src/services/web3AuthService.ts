import { Web3Auth } from "@web3auth/modal";
import { ethers } from "ethers";

const chainConfig = {
  chainNamespace: "eip155" as const,
  chainId: "0x7a69",
  rpcTarget:
    (import.meta.env.VITE_HARDHAT_RPC_URL as string | undefined) ??
    "http://127.0.0.1:8545",
  displayName: "Hardhat Local",
  ticker: "ETH",
  tickerName: "Ethereum",
  blockExplorerUrl: "",
  logo: "",
};

let web3Auth: Web3Auth | null = null;
let initialization: Promise<Web3Auth> | null = null;

async function getWeb3Auth(): Promise<Web3Auth> {
  if (web3Auth) return web3Auth;
  if (initialization) return initialization;

  const clientId = import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined;
  if (!clientId) {
    throw new Error("Web3Auth non configuré. Définissez VITE_WEB3AUTH_CLIENT_ID.");
  }

  initialization = (async () => {
    const instance = new Web3Auth({
      clientId,
      web3AuthNetwork: "sapphire_devnet",
      chains: [chainConfig],
      defaultChainId: chainConfig.chainId,
      storageType: "local",
    });
    await instance.init();
    web3Auth = instance;
    return instance;
  })();

  try {
    return await initialization;
  } finally {
    initialization = null;
  }
}

export async function connectWeb3Auth() {
  const instance = await getWeb3Auth();
  const provider = await instance.connect();
  if (!provider) throw new Error("Web3Auth n'a retourné aucun provider.");

  const browserProvider = new ethers.BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  const address = await signer.getAddress();
  const userInfo = await instance.getUserInfo();
  const identityToken = await instance.getIdentityToken();

  return {
    address,
    email: userInfo.email ?? "",
    fullName: userInfo.name ?? "",
    idToken: identityToken.idToken,
    signer,
  };
}

export async function disconnectWeb3Auth() {
  if (web3Auth?.connected) {
    await web3Auth.logout({ cleanup: true });
  }
}
