# 🗳️ Saffra — Plateforme de Vote Électronique Anonyme (ZK-SNARKs & Semaphore v4)

**Saffra** est un système de vote électronique décentralisé et hautement sécurisé pour les élections universitaires (délégués de promotion, associations étudiantes, référendums). Il garantit un **anonymat cryptographique absolu** tout en assurant une **vérifiabilité publique** et une **protection stricte contre le double vote**, grâce aux preuves à divulgation nulle de connaissance (**Zero-Knowledge Proofs - ZKP**) fournies par le protocole **Semaphore v4**.

---

## 📌 Présentation du Projet

Dans un système de vote blockchain classique, l'adresse du portefeuille (wallet) soumettant le bulletin est publique, ce qui compromet le secret du vote si cette adresse est associée à l'identité d'un étudiant. 

**Saffra résout ce dilemme :**
1. **Authentification Web3Auth** : L'étudiant s'authentifie simplement avec son compte universitaire (Google SSO ou Email), sans logiciel ni extension à installer.
2. **Dissociation Identité / Vote (Semaphore v4)** : Une identité secrète Semaphore est générée localement dans le navigateur de l'étudiant. Seul son *identity commitment* public est inscrit dans un arbre de Merkle on-chain.
3. **Preuve ZK (Zero-Knowledge)** : Lors du vote, le navigateur produit une preuve ZK (Groth16/Snark) attestant que le votant fait bien partie de l'arbre de Merkle des étudiants autorisés, sans jamais révéler de quelle feuille il s'agit.
4. **Anti-Double Vote (Nullifier)** : Un identifiant unique appelé *nullifier* est calculé cryptographiquement à partir du secret de l'étudiant et de l'identifiant du scrutin (scope). Le contrat intelligent rejette tout vote réutilisant un même nullifier.
5. **Relayer sans gaz** : Le bulletin est transmis au contrat par un serveur Relayer tiers qui prend en charge les frais de gaz. L'adresse de l'étudiant n'apparaît jamais sur la blockchain.
6. **Dépouillement public et audit en direct** : N'importe quel observateur ou étudiant peut suivre les résultats en direct en écoutant les événements `VoteEmis` sur la blockchain et vérifier que le nombre de votants ne dépasse pas la liste électorale officielle (audit anti-bourrage d'urnes).

---

## 🏗️ Architecture du Système

| Composant | Rôle & Responsabilité | Technologies |
| :--- | :--- | :--- |
| **Smart Contract `Voting.sol`** | Gère le scrutin, contrôle les fenêtres temporelles (`block.timestamp`), valide les preuves ZK on-chain via Semaphore, stocke les nullifiers et comptabilise les votes. | Solidity, Hardhat, Semaphore v4 |
| **Semaphore Contracts** | Fournit les contrats de base (`Semaphore.sol`, `SemaphoreVerifier.sol`, `PoseidonT3`) et maintient l'arbre de Merkle. | `@semaphore-protocol/contracts` |
| **Authentification Étudiante** | Fournit un signer sécurisé et identifie l'étudiant sans friction Web3. | Web3Auth (Google SSO, Email OTP) |
| **Registre Universitaire** | Vérifie l'éligibilité des étudiants et le drapeau d'inscription unique. | Supabase / PostgreSQL (`etudiants`, `inscriptions_vote`) |
| **Backend API & Relayer** | Vérifie les tokens Web3Auth, met en file d'attente les commitments et les insère par lots mélangés (*shuffled batches*), relaie les transactions de vote sans frais pour l'électeur. | Node.js, Express, ethers.js |
| **Frontend Applicatif** | Interface étudiant (dérivation d'identité, calcul de preuve ZK dans le navigateur, vote), tableau de bord d'administration et dépouillement en direct. | React 19, TypeScript, Vite, Tailwind CSS, Lucide |

---

## 🔄 Flux Fonctionnel de Bout en Bout

```
[ Étudiant ] ──( 1. Connexion SSO )──> [ Web3Auth ]
     │                                       │
     │ (2. Génération identité locale)       │ (Token JWT)
     ▼                                       ▼
[ Navigateur ] ──( 3. Commitment )────> [ Backend API / Supabase ]
                                             │ (Vérifie éligibilité)
                                             │ (4. Ajout par lot mélangé)
                                             ▼
                                  [ Contrat Semaphore ]
                                    (Arbre de Merkle)
                                             │
     ┌───────────────────────────────────────┘
     │ (5. Téléchargement de l'arbre public)
     ▼
[ Navigateur ] ──( 6. Génération Preuve ZK in-browser )
     │             - Message : ID Candidat
     │             - Scope   : ID Scrutin
     │             - Secret  : Identité Semaphore
     ▼
[ Relayer API ] ──( 7. Envoi transaction avec gaz pris en charge )
     ▼
[ Contrat Voting ] ──( 8. semaphore.validateProof() & Enregistrement du nullifier )
     ▼
[ Événement VoteEmis ] ──> Mise à jour instantanée du tableau des résultats en direct
```

---

## 🛡️ Confidentialité et Sécurité (Privacy Analysis)

- **Secret local inviolable** : L'identité Semaphore secrète ne quitte jamais le navigateur du client.
- **Dérivation déterministe récupérable** : L'identité Semaphore peut être dérivée d'une signature privée du wallet Web3Auth, permettant à l'étudiant de récupérer son droit de vote même s'il vide son cache.
- **Sauvegarde chiffrée** : Sauvegarde locale chiffrée en AES-GCM (256-bit) dans le `localStorage` avec export JSON disponible.
- **Protection contre la corrélation temporelle** : Le backend enregistre les commitments par **lots mélangés** (*shuffled batches*) afin qu'un observateur ne puisse pas corréler l'ordre d'inscription avec l'ordre d'apparition sur la blockchain.
- **Inaltérabilité du bulletin** : Le choix du candidat fait partie intégrante du message prouvé en ZK. Si un relayer malveillant tente de changer le candidat, la vérification on-chain échoue immédiatement.

---

## 📂 Structure du Répertoire

```text
├── server/                         # Serveur backend Express & Relayer
│   └── index.ts                    # Routes /auth/verify, /register, /relay-vote, /admin/elections
├── src/                            # Application Frontend React
│   ├── abi/                        # Interfaces ABI des smart contracts
│   ├── components/                 # Composants UI (Navbar, Footer, Modals...)
│   ├── context/                    # VotingContext (gestion d'état & écoute on-chain)
│   ├── pages/                      # Pages principales (Home, Elections, Results, Admin, About)
│   ├── services/                   # Services ZK (semaphoreService, web3AuthService, etc.)
│   └── types/                      # Définitions TypeScript
├── voting-semaphore/               # Environnement Hardhat & Smart Contracts
│   ├── contracts/                  # Contrats Solidity (Voting.sol)
│   ├── scripts/                    # Scripts de déploiement et utilitaires ZK
│   └── test/                       # Tests unitaires et d'intégration (Voting.ts)
├── public/artifacts/               # Fichiers de circuits ZK Semaphore (WASM et zkey locaux)
├── scripts/                        # Scripts utilitaires Supabase
└── README.md                       # Documentation du projet
```

---

## 🚀 Guide de Démarrage Rapide

### Prérequis
- **Node.js** (v18+)
- **npm** ou **bun**

### 1. Installation des dépendances

```bash
# Dépendances principales (Frontend & Backend)
npm install

# Dépendances des contrats intelligents
cd voting-semaphore
npm install
cd ..
```

### 2. Configuration des variables d'environnement

Copiez le fichier `.env.example` vers `.env` et adaptez les valeurs si nécessaire :

```bash
cp .env.example .env
```

### 3. Lancer la Blockchain Locale (Hardhat)

Dans un terminal dédié :
```bash
cd voting-semaphore
npx hardhat node
```
*Le nœud démarre sur `http://127.0.0.1:8545` (Chain ID : 31337).*

### 4. Déployer les contrats Semaphore & Voting

Dans un second terminal :
```bash
cd voting-semaphore
npx hardhat run scripts/deploy-semaphore.ts --network localhost
```
*Notez l'adresse déployée de Semaphore et reportez-la dans votre fichier `.env`.*

Pour exécuter la suite de tests automatisés :
```bash
npx hardhat test
```

### 5. Lancer le Serveur Backend (API & Relayer)

```bash
npm run server
```
*Le backend démarre sur `http://localhost:3001`.*

### 6. Démarrer l'Application Frontend

Dans un autre terminal :
```bash
npm run dev
```
Ouvrez votre navigateur à l'adresse **`http://localhost:3000`**.

---

## 👥 Comptes de Démonstration

L'application intègre des comptes étudiants pré-configurés pour tester directement les différents scénarios :
- **Amina Benali** (`amina.benali@univ-saffra.edu`) : Étudiante éligible (Master Informatique).
- **Thomas Dubois** (`thomas.dubois@univ-saffra.edu`) : Étudiant éligible (Licence Droit).
- **Sarah Mansouri** (`sarah.mansouri@univ-saffra.edu`) : Étudiante éligible (Master Économie).
- **Lucas Moreno** (`lucas.moreno@gmail.com`) : Compte externe non éligible (rejet d'inscription).

---

## 📄 Licence
Projet académique développé sous licence MIT.
