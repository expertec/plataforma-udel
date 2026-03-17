import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  decryptSecretText,
  type EncryptedSecretPayload,
} from "@/lib/security/encrypted-secrets";
import {
  KanwapApiError,
  getKanwapSessionStatus,
  sendKanwapTextMessage,
} from "@/lib/server/kanwap-client";

const ADMIN_INTEGRATIONS_COLLECTION = "adminIntegrations";
const KANWAP_FIELD = "whatsappKanwap";
const GLOBAL_SETTINGS_DOC_ID = "global-settings";
const GLOBAL_WHATSAPP_ENABLED_FIELD = "whatsappNotificationsEnabled";
const MAX_INTEGRATION_SCAN = 120;

type StoredKanwapConfig = {
  sessionId: string;
  sessionState: string;
  apiKeyEncrypted: EncryptedSecretPayload;
};

type ResolvedKanwapConnection = {
  ownerUid: string;
  sessionId: string;
  sessionState: string;
  apiKey: string;
};

export type WhatsAppSendOutcome =
  | {
      notified: true;
      destination: string;
      messageId?: string;
      ownerUid: string;
    }
  | {
      notified: false;
      reason: string;
      retryable?: boolean;
    };

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asEncryptedSecret(value: unknown): EncryptedSecretPayload | null {
  const payload = asRecord(value);
  if (!payload) return null;
  const iv = asText(payload.iv);
  const tag = asText(payload.tag);
  const cipherText = asText(payload.cipherText);
  if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") return null;
  if (!iv || !tag || !cipherText) return null;
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv,
    tag,
    cipherText,
  };
}

function parseKanwapConfig(rawValue: unknown): StoredKanwapConfig | null {
  const raw = asRecord(rawValue);
  if (!raw) return null;
  const sessionId = asText(raw.sessionId);
  const apiKeyEncrypted = asEncryptedSecret(raw.apiKeyEncrypted);
  if (!sessionId || !apiKeyEncrypted) return null;
  return {
    sessionId,
    sessionState: asText(raw.sessionState) || "desconectada",
    apiKeyEncrypted,
  };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeWhatsAppDestination(rawPhone: string): string {
  let digits = digitsOnly(rawPhone);
  if (!digits) return "";

  // Permitir prefijo internacional con 00 (ej. 005218311159174).
  while (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (!digits) return "";

  // MX: formato recomendado por KanWap para móviles.
  if (digits.startsWith("521") && digits.length === 13) {
    return digits;
  }
  if (digits.startsWith("52") && digits.length === 12) {
    return `521${digits.slice(2)}`;
  }
  if (digits.length === 10) {
    return `521${digits}`;
  }

  // Fallback E.164 internacional (sin +): 8..15 dígitos.
  if (digits.length >= 8 && digits.length <= 15) {
    return digits;
  }

  return "";
}

function maskDestination(destination: string): string {
  const digits = digitsOnly(destination);
  if (digits.length < 4) return digits;
  return `${digits.slice(0, 5)}*****${digits.slice(-3)}`;
}

function extractPhoneCandidates(rawData: Record<string, unknown> | null): string[] {
  if (!rawData) return [];
  const keys = [
    "whatsapp",
    "WhatsApp",
    "whatsApp",
    "wa",
    "whatsappPhone",
    "whatsappNumber",
    "phone",
    "Phone",
    "telefono",
    "tel",
    "cellphone",
    "mobile",
  ];

  const candidates: string[] = [];
  const toCandidate = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    return "";
  };

  keys.forEach((key) => {
    const value = toCandidate(rawData[key]);
    if (value) candidates.push(value);
  });
  return candidates;
}

function chooseConnectionFromCandidates(candidates: ResolvedKanwapConnection[]): ResolvedKanwapConnection | null {
  if (!candidates.length) return null;
  const connected = candidates.find(
    (item) => item.sessionState.toLowerCase() === "conectada",
  );
  return connected ?? candidates[0];
}

async function areGlobalWhatsAppNotificationsEnabled(): Promise<boolean> {
  try {
    const db = getAdminFirestore();
    const snap = await db
      .collection(ADMIN_INTEGRATIONS_COLLECTION)
      .doc(GLOBAL_SETTINGS_DOC_ID)
      .get();
    return snap.data()?.[GLOBAL_WHATSAPP_ENABLED_FIELD] !== false;
  } catch {
    // Fail-open: si no podemos leer este ajuste, mantenemos el comportamiento actual.
    return true;
  }
}

export async function resolveKanwapConnection(
  preferredOwnerUid?: string,
): Promise<ResolvedKanwapConnection | null> {
  const db = getAdminFirestore();

  const fromDoc = async (ownerUid: string) => {
    const snap = await db.collection(ADMIN_INTEGRATIONS_COLLECTION).doc(ownerUid).get();
    if (!snap.exists) return null;
    const config = parseKanwapConfig(snap.data()?.[KANWAP_FIELD]);
    if (!config) return null;
    try {
      return {
        ownerUid,
        sessionId: config.sessionId,
        sessionState: config.sessionState,
        apiKey: decryptSecretText(config.apiKeyEncrypted),
      } as ResolvedKanwapConnection;
    } catch {
      return null;
    }
  };

  if (preferredOwnerUid) {
    const own = await fromDoc(preferredOwnerUid);
    if (own) return own;
  }

  const snap = await db
    .collection(ADMIN_INTEGRATIONS_COLLECTION)
    .limit(MAX_INTEGRATION_SCAN)
    .get();
  const candidates: ResolvedKanwapConnection[] = [];
  for (const docSnap of snap.docs) {
    const config = parseKanwapConfig(docSnap.data()?.[KANWAP_FIELD]);
    if (!config) continue;
    try {
      const apiKey = decryptSecretText(config.apiKeyEncrypted);
      candidates.push({
        ownerUid: docSnap.id,
        sessionId: config.sessionId,
        sessionState: config.sessionState,
        apiKey,
      });
    } catch {
      // Ignorar configuraciones corruptas.
    }
  }
  return chooseConnectionFromCandidates(candidates);
}

async function resolveStudentDestination(params: {
  studentId: string;
  groupId?: string;
}): Promise<{ destination: string; studentName?: string } | null> {
  const db = getAdminFirestore();
  const studentId = asText(params.studentId);
  if (!studentId) return null;

  const userSnap = await db.collection("users").doc(studentId).get();
  const userData = asRecord(userSnap.data()) ?? {};
  const groupStudentData =
    params.groupId && asText(params.groupId)
      ? asRecord(
          (
            await db
              .collection("groups")
              .doc(asText(params.groupId))
              .collection("students")
              .doc(studentId)
              .get()
          ).data(),
        )
      : null;

  const candidates = [
    ...extractPhoneCandidates(userData),
    ...extractPhoneCandidates(groupStudentData),
  ];

  const destination = candidates
    .map((candidate) => normalizeWhatsAppDestination(candidate))
    .find(Boolean);
  if (!destination) return null;

  const studentName =
    asText(userData.name) ||
    asText(userData.displayName) ||
    asText(groupStudentData?.studentName);
  return {
    destination,
    studentName: studentName || undefined,
  };
}

export async function sendWhatsAppTextToStudent(params: {
  studentId: string;
  message: string;
  groupId?: string;
  preferredOwnerUid?: string;
}): Promise<WhatsAppSendOutcome> {
  const message = params.message.trim();
  if (!message) {
    return { notified: false, reason: "Mensaje vacío" };
  }

  const notificationsEnabled = await areGlobalWhatsAppNotificationsEnabled();
  if (!notificationsEnabled) {
    return {
      notified: false,
      reason: "Las notificaciones globales de WhatsApp están apagadas",
    };
  }

  const connection = await resolveKanwapConnection(params.preferredOwnerUid);
  if (!connection) {
    return {
      notified: false,
      reason: "No hay una sesión de WhatsApp conectada en admin",
    };
  }

  const target = await resolveStudentDestination({
    studentId: params.studentId,
    groupId: params.groupId,
  });
  if (!target?.destination) {
    return {
      notified: false,
      reason: "El alumno no tiene teléfono/WhatsApp válido",
    };
  }

  try {
    const status = await getKanwapSessionStatus(
      connection.apiKey,
      connection.sessionId,
    );
    const state = asText(status.estado).toLowerCase();
    if (state !== "conectada") {
      return {
        notified: false,
        reason: `La sesión de WhatsApp está ${status.estado || "desconocida"}`,
      };
    }

    const result = await sendKanwapTextMessage({
      apiKey: connection.apiKey,
      sessionId: connection.sessionId,
      destination: target.destination,
      message,
    });

    if (result.enviado !== true) {
      return {
        notified: false,
        reason: "KanWap no confirmó el envío",
      };
    }

    return {
      notified: true,
      destination: maskDestination(target.destination),
      messageId: result.mensajeId,
      ownerUid: connection.ownerUid,
    };
  } catch (error: unknown) {
    if (error instanceof KanwapApiError) {
      return {
        notified: false,
        reason: error.message,
        retryable: error.retryable,
      };
    }
    return {
      notified: false,
      reason: "Error enviando WhatsApp",
      retryable: true,
    };
  }
}
