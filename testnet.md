# 🚀 Plan de Déploiement sur Sepolia Testnet

> [!IMPORTANT]
> Ce plan est **lecture seule** — aucune modification de code n'est effectuée. Exécute les commandes dans l'ordre.

---

## Architecture du projet

```
saffra-master/
├── voting-semaphore/        ← Contrats Solidity (Hardhat)
│   ├── contracts/Voting.sol
│   ├── hardhat.config.ts    ← réseau "sepolia" déjà configuré ✅
│   └── scripts/deploy-all.ts
├── server/index.ts          ← Backend Express (relayer + registrar)
├── src/                     ← Frontend React (Vite)
└── .env                     ← Variables d'environnement
```

---

## PHASE 1 — Préparer les secrets & le compte déployeur

### 1.1 Obtenir des ETH de test sur Sepolia

1. Va sur [https://sepoliafaucet.com](https://sepoliafaucet.com) ou [https://faucet.sepolia.dev](https://faucet.sepolia.dev)
2. Colle l'adresse de ton wallet déployeur → reçois ~0.5 ETH testnet
3. Minimum requis : **~0.1 ETH** (déploiement Semaphore + Voting + gas)

### 1.2 Obtenir un RPC Sepolia

Crée un compte gratuit sur **Alchemy** ou **Infura** :
- Alchemy : https://dashboard.alchemy.com → New App → Ethereum Sepolia
- Copie l'URL : `https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY`

---

## PHASE 2 — Configurer le fichier `.env`

Édite [.env](file:///c:/Users/ahmed/OneDrive/Documents/saffra-master/saffra-master/.env) et remplis ces variables :

```dotenv
# ── SEPOLIA (déploiement contrats) ──────────────────────────────
SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
SEPOLIA_PRIVATE_KEY="0xTON_WALLET_PRIVE"      # compte déployeur (aura des ETH testnet)

# ── BACKEND (relayer & registrar) ───────────────────────────────
RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
REGISTRAR_PRIVATE_KEY="0xTON_WALLET_PRIVE"    # même clé ou clé dédiée
RELAYER_PRIVATE_KEY="0xCLE_RELAYER"           # compte qui signe les tx de vote

# ── FRONTEND ────────────────────────────────────────────────────
VITE_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
VITE_HARDHAT_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
VITE_RELAYER_URL="https://TON_BACKEND_URL"    # URL publique du backend
VITE_API_URL="https://TON_BACKEND_URL"

# ── FRONTEND_ORIGIN (CORS) ──────────────────────────────────────
FRONTEND_ORIGIN="https://TON_FRONTEND_URL"

# ── SUPABASE (inchangé) ─────────────────────────────────────────
SUPABASE_URL="..."
SUPABASE_PUBLISHABLE_KEY="..."
VITE_SUPABASE_URL="..."
VITE_SUPABASE_PUBLISHABLE_KEY="..."
SUPABASE_SERVICE_ROLE_KEY="..."

# ── WEB3AUTH ────────────────────────────────────────────────────
WEB3AUTH_CLIENT_ID="..."
VITE_WEB3AUTH_CLIENT_ID="..."

# ── Ces deux seront auto-remplis par le script de déploiement ───
SEMAPHORE_ADDRESS=""
ELECTION_1_CONTRACT=""
```

> [!CAUTION]
> Ne commite jamais `.env` sur Git. Vérifie que `.gitignore` contient bien `.env`.

---

## PHASE 3 — Déployer les contrats sur Sepolia

### 3.1 Ajouter le réseau Sepolia dans `hardhat.config.ts`

> [!NOTE]
> `hardhat.config.ts` a **déjà** la config Sepolia :
> ```ts
> sepolia: {
>   type: "http",
>   chainType: "l1",
>   url: configVariable("SEPOLIA_RPC_URL"),
>   accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
> }
> ```
> ✅ Aucune modification nécessaire.

### 3.2 Script de déploiement

Le script `deploy-all.ts` utilise maintenant le réseau transmis à Hardhat avec `--network`. Il charge le `.env` de la racine du projet et refuse tout réseau autre que localhost et Sepolia.

### 3.3 Commandes de déploiement

```bash
# 1. Aller dans le dossier contrats
cd voting-semaphore

# 2. Compiler les contrats
npx hardhat build

# 3. Déployer sur Sepolia
npm run deploy:sepolia
```

**Résultat attendu :**
```
PoseidonT3 deployed at:      0x...
SemaphoreVerifier deployed at: 0x...
Semaphore deployed at:         0x...
Voting (ELECTION_1_CONTRACT) deployed at: 0x...
✅ .env mis à jour
```

Le script met à jour automatiquement `.env` :
- `SEMAPHORE_ADDRESS="0x..."` ← adresse du contrat Semaphore
- `ELECTION_1_CONTRACT="0x..."` ← adresse du contrat Voting

---

## PHASE 4 — Vérifier les contrats sur Etherscan (optionnel)

```bash
# Depuis voting-semaphore/
npx hardhat verify --network sepolia ADRESSE_VOTING \
  ADRESSE_SEMAPHORE \
  "Élection des Délégués Étudiants 2026" \
  '["Liste Horizon Campus","Collectif Avenir Solidaire","Alliance Tech & Culture"]' \
  START_TIME END_TIME ADRESSE_REGISTRAR
```

> [!TIP]
> Pour vérifier, il faut ajouter `ETHERSCAN_API_KEY` dans `.env` et configurer Hardhat Verify plugin.

---

## PHASE 5 — Déployer le Backend (serveur Express)

### Option A — VPS / Serveur Cloud (Railway, Render, Fly.io)

```bash
# Build TypeScript
npm run build   # si tu as un script de build backend

# Lancer le serveur
npm run server  # = tsx server/index.ts
```

Variables d'environnement à configurer sur la plateforme :
| Variable | Valeur |
|---|---|
| `RPC_URL` | URL Alchemy Sepolia |
| `REGISTRAR_PRIVATE_KEY` | Clé privée registrar |
| `RELAYER_PRIVATE_KEY` | Clé privée relayer |
| `SEMAPHORE_ADDRESS` | Adresse déployée phase 3 |
| `ELECTION_1_CONTRACT` | Adresse déployée phase 3 |
| `SUPABASE_URL` | URL Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service Supabase |
| `WEB3AUTH_ISSUER` | `https://api-auth.web3auth.io` |
| `WEB3AUTH_CLIENT_ID` | Ton client ID |
| `FRONTEND_ORIGIN` | URL frontend déployé |
| `API_PORT` | `3001` |

### Option B — Google Cloud Run (AI Studio style)

```bash
# Construire l'image Docker
docker build -t saffra-backend .

# Déployer sur Cloud Run
gcloud run deploy saffra-backend \
  --image gcr.io/TON_PROJECT/saffra-backend \
  --platform managed \
  --region europe-west1 \
  --set-env-vars RPC_URL=...,SEMAPHORE_ADDRESS=...
```

---

## PHASE 6 — Déployer le Frontend (React/Vite)

```bash
# Depuis la racine du projet
# S'assurer que les VITE_* variables sont bien définies dans .env
npm run build   # génère dist/

# Déployer dist/ sur :
# - Vercel : vercel deploy --prod
# - Netlify : netlify deploy --prod --dir=dist
# - Ou servir avec le backend Express (déjà fait si server/index.ts sert dist/)
```

> [!TIP]
> Le backend Express sert probablement déjà le frontend depuis `dist/`. Dans ce cas, le frontend et le backend peuvent être déployés **ensemble** sur une seule plateforme.

---

## PHASE 7 — Mise à jour de Web3Auth

Dans le dashboard Web3Auth (https://dashboard.web3auth.io) :
1. Ajoute l'URL de ton frontend dans les **Whitelisted URLs**
2. Configure le **réseau** sur `sapphire_devnet` (testnet) ou `mainnet`
3. Vérifie que `VITE_WEB3AUTH_CLIENT_ID` correspond

---

## Checklist finale

- [ ] ETH testnet Sepolia sur le compte déployeur
- [ ] `SEPOLIA_RPC_URL` configuré dans `.env`
- [ ] `SEPOLIA_PRIVATE_KEY` configuré dans `.env`
- [ ] Contrats compilés : `npx hardhat build`
- [ ] Contrats déployés : `npx hardhat run scripts/deploy-all.ts --network sepolia`
- [ ] `.env` mis à jour avec `SEMAPHORE_ADDRESS` et `ELECTION_1_CONTRACT`
- [ ] Backend déployé avec toutes les variables d'env
- [ ] Frontend buildé (`npm run build`) et déployé
- [ ] `VITE_RELAYER_URL` pointe vers le backend public
- [ ] `FRONTEND_ORIGIN` configuré sur le backend (CORS)
- [ ] Web3Auth whitelist mis à jour

---

## Réseau Sepolia — Infos utiles

| Info | Valeur |
|---|---|
| Chain ID | `11155111` |
| Explorer | https://sepolia.etherscan.io |
| Faucet | https://sepoliafaucet.com |
| RPC public | `https://rpc.sepolia.org` (lent, préfère Alchemy) |
