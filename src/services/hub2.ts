/**
 * Service HUB2 - Mobile Money (Orange Money, MTN MoMo, Wave, Moov Money)
 * Pattern identique à l'intégration MOBILE-PAY.
 */

const HUB2_BASE_URL = process.env.HUB2_BASE_URL || "https://api.hub2.io/v1";
const HUB2_CLIENT_ID = process.env.HUB2_CLIENT_ID as string;
const HUB2_CLIENT_SECRET = process.env.HUB2_CLIENT_SECRET as string;

type Operateur = "orange_money" | "mtn_momo" | "wave" | "moov_money";

interface PayInParams {
  montant: number;
  telephone: string;
  operateur: Operateur;
  reference: string; // référence interne ProxiGaz (ex: commande_gaz.id)
  description: string;
}

interface Hub2TokenResponse {
  access_token: string;
  expires_in: number;
}

interface Hub2PayInResponse {
  transaction_id: string;
  reference: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
  message?: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const res = await fetch(`${HUB2_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: HUB2_CLIENT_ID,
      client_secret: HUB2_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`HUB2 auth échouée: ${res.status}`);
  }

  const data = (await res.json()) as Hub2TokenResponse;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

/**
 * Initie un paiement Mobile Money (Pay-in) via HUB2.
 * Le client reçoit une notification USSD/push sur son téléphone pour valider.
 */
export async function initierPaiement(params: PayInParams): Promise<Hub2PayInResponse> {
  const token = await getAccessToken();

  const res = await fetch(`${HUB2_BASE_URL}/payments/collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      amount: params.montant,
      currency: "XOF",
      phone_number: params.telephone,
      operator: params.operateur,
      external_reference: params.reference,
      description: params.description,
      callback_url: `${process.env.API_BASE_URL}/api/webhooks/hub2`,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HUB2 pay-in échoué: ${res.status} - ${errText}`);
  }

  return (await res.json()) as Hub2PayInResponse;
}

/**
 * Vérifie le statut d'une transaction HUB2 (polling de secours si le webhook n'arrive pas).
 */
export async function verifierStatutPaiement(transactionId: string): Promise<Hub2PayInResponse> {
  const token = await getAccessToken();

  const res = await fetch(`${HUB2_BASE_URL}/payments/${transactionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`HUB2 vérification échouée: ${res.status}`);
  }

  return (await res.json()) as Hub2PayInResponse;
}

export type { Operateur, PayInParams, Hub2PayInResponse };
