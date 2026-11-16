import type { EligibilityStatus } from "../types/voting";

interface StudentRecord {
  id: string;
}

interface RegistrationRecord {
  is_eligible: boolean;
  is_registered: boolean;
}

function getApiUrl(): string | null {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  return url ? url.replace(/\/+$/, "") : null;
}

async function backendRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const apiUrl = getApiUrl();
  if (!apiUrl) throw new Error("Backend API non configuré.");
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Le backend a répondu HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function getSupabaseConfig() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key =
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

  if (!url || !key) {
    throw new Error(
      "Supabase n'est pas configuré. Définissez VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY."
    );
  }

  return { url: url.replace(/\/+$/, ""), key };
}

async function supabaseRequest<T>(
  path: string,
  token: string,
  config: ReturnType<typeof getSupabaseConfig>
): Promise<T> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "x-web3auth-token": token,
    },
  });

  if (!response.ok) {
    throw new Error(
      `La vérification Supabase a échoué (HTTP ${response.status}). Vérifiez les politiques RLS.`
    );
  }

  return (await response.json()) as T;
}

async function findStudentId(
  email: string,
  token: string,
  config: ReturnType<typeof getSupabaseConfig>
): Promise<string | null> {
  const rows = await supabaseRequest<StudentRecord[]>(
    `etudiants?select=id&email=eq.${encodeURIComponent(email.trim().toLowerCase())}&limit=1`,
    token,
    config
  );
  return rows[0]?.id ?? null;
}

export async function checkSupabaseEligibility(
  email: string,
  electionId: string,
  web3AuthToken: string
): Promise<EligibilityStatus> {
  if (!web3AuthToken) {
    throw new Error("Token Web3Auth manquant.");
  }

  if (getApiUrl()) {
    const result = await backendRequest<{ status: EligibilityStatus }>(
      `/eligibility?electionId=${encodeURIComponent(electionId)}`,
      web3AuthToken
    );
    return result.status;
  }

  const config = getSupabaseConfig();
  const studentId = await findStudentId(email, web3AuthToken, config);
  if (!studentId) return "not_on_list";

  const registrations = await supabaseRequest<RegistrationRecord[]>(
    `inscriptions_vote?select=is_eligible,is_registered&etudiant_id=eq.${encodeURIComponent(
      studentId
    )}&election_id=eq.${encodeURIComponent(electionId)}&limit=1`,
    web3AuthToken,
    config
  );

  const registration = registrations[0];
  if (registration && !registration.is_eligible) return "not_on_list";
  if (registration?.is_registered) return "already_registered";
  return "eligible";
}

export async function registerStudentForElection(
  email: string,
  electionId: string,
  commitment: string,
  web3AuthToken: string
): Promise<"registered" | "already_registered" | "not_on_list"> {
  if (!web3AuthToken) {
    throw new Error("Token Web3Auth manquant.");
  }

  if (getApiUrl()) {
    const result = await backendRequest<{ status: string }>("/register", web3AuthToken, {
      method: "POST",
      body: JSON.stringify({ electionId, commitment }),
    });
    if (result.status === "queued") return "registered";
    if (result.status === "not_on_list") return "not_on_list";
    return "already_registered";
  }

  const config = getSupabaseConfig();
  const studentId = await findStudentId(email, web3AuthToken, config);
  if (!studentId) return "not_on_list";

  const response = await fetch(
    `${config.url}/rest/v1/inscriptions_vote?etudiant_id=eq.${encodeURIComponent(
      studentId
    )}&election_id=eq.${encodeURIComponent(
      electionId
    )}&is_eligible=eq.true&is_registered=eq.false`,
    {
      method: "PATCH",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        "x-web3auth-token": web3AuthToken,
      },
      body: JSON.stringify({
        is_registered: true,
        registered_at: new Date().toISOString(),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `L'inscription Supabase a échoué (HTTP ${response.status}). Vérifiez les politiques RLS.`
    );
  }

  const updatedRows = (await response.json()) as RegistrationRecord[];
  return updatedRows.length > 0 ? "registered" : "already_registered";
}
