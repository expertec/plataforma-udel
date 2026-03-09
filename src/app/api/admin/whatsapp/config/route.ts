import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireAdminTeacher,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";
import {
  KanwapApiError,
  getKanwapBaseUrlForDisplay,
  getKanwapSessionStatus,
  listKanwapSessions,
} from "@/lib/server/kanwap-client";
import {
  decryptSecretText,
  encryptSecretText,
  isSecretEncryptionConfigured,
  maskSecret,
  type EncryptedSecretPayload,
} from "@/lib/security/encrypted-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADMIN_INTEGRATIONS_COLLECTION = "adminIntegrations";
const KANWAP_FIELD = "whatsappKanwap";

type UpsertWhatsAppConfigRequest = {
  apiKey?: string;
  sessionId?: string;
  sessionName?: string;
  phone?: string;
};

type StoredKanwapConfig = {
  provider: "kanwap";
  baseUrl: string;
  sessionId: string;
  sessionName: string | null;
  phone: string | null;
  sessionState: string;
  apiKeyMasked: string;
  apiKeyEncrypted: EncryptedSecretPayload;
  createdAt: Date | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function asEncryptedSecret(value: unknown): EncryptedSecretPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const version = payload.version;
  const algorithm = payload.algorithm;
  const iv = asText(payload.iv);
  const tag = asText(payload.tag);
  const cipherText = asText(payload.cipherText);
  if (version !== 1 || algorithm !== "aes-256-gcm") return null;
  if (!iv || !tag || !cipherText) return null;
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv,
    tag,
    cipherText,
  };
}

function parseStoredKanwapConfig(value: unknown): StoredKanwapConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sessionId = asText(raw.sessionId);
  const apiKeyMasked = asText(raw.apiKeyMasked);
  const apiKeyEncrypted = asEncryptedSecret(raw.apiKeyEncrypted);
  if (!sessionId || !apiKeyMasked || !apiKeyEncrypted) return null;

  return {
    provider: "kanwap",
    baseUrl: asText(raw.baseUrl) || getKanwapBaseUrlForDisplay(),
    sessionId,
    sessionName: asText(raw.sessionName) || null,
    phone: asText(raw.phone) || null,
    sessionState: asText(raw.sessionState) || "desconocida",
    apiKeyMasked,
    apiKeyEncrypted,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    updatedBy: asText(raw.updatedBy) || null,
    lastValidatedAt: toDate(raw.lastValidatedAt),
    lastValidationError: asText(raw.lastValidationError) || null,
  };
}

function kanwapErrorResponse(error: KanwapApiError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
      errors: error.errors,
      retryable: error.retryable,
    },
    { status: error.status || 502 },
  );
}

function mapPublicConfig(config: StoredKanwapConfig, params?: { liveState?: string; liveError?: string | null }) {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    sessionId: config.sessionId,
    sessionName: config.sessionName,
    phone: config.phone,
    sessionState: params?.liveState ?? config.sessionState,
    apiKeyMasked: config.apiKeyMasked,
    createdAt: toIso(config.createdAt),
    updatedAt: toIso(config.updatedAt),
    updatedBy: config.updatedBy,
    lastValidatedAt: toIso(config.lastValidatedAt),
    lastValidationError: params?.liveError ?? config.lastValidationError,
  };
}

export async function GET(request: NextRequest) {
  try {
    const adminContext = await requireAdminTeacher(request);
    const shouldRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const docRef = getAdminFirestore()
      .collection(ADMIN_INTEGRATIONS_COLLECTION)
      .doc(adminContext.uid);
    const snap = await docRef.get();
    const config = parseStoredKanwapConfig(snap.data()?.[KANWAP_FIELD]);

    if (!config) {
      return NextResponse.json(
        {
          success: true,
          data: null,
          encryptionConfigured: isSecretEncryptionConfigured(),
        },
        { status: 200 },
      );
    }

    if (!shouldRefresh) {
      return NextResponse.json(
        {
          success: true,
          data: mapPublicConfig(config),
          encryptionConfigured: isSecretEncryptionConfigured(),
        },
        { status: 200 },
      );
    }

    try {
      const apiKey = decryptSecretText(config.apiKeyEncrypted);
      const liveStatus = await getKanwapSessionStatus(apiKey, config.sessionId);
      const now = new Date();
      const sessionState = asText(liveStatus.estado) || config.sessionState;
      const sessionName = config.sessionName || asText(liveStatus.nombre) || null;
      const phone = config.phone || asText(liveStatus.telefono) || null;

      await docRef.set(
        {
          [KANWAP_FIELD]: {
            sessionState,
            sessionName,
            phone,
            lastValidatedAt: now,
            lastValidationError: null,
            updatedAt: now,
          },
        },
        { merge: true },
      );

      return NextResponse.json(
        {
          success: true,
          data: mapPublicConfig(
            {
              ...config,
              sessionState,
              sessionName,
              phone,
              lastValidatedAt: now,
              lastValidationError: null,
              updatedAt: now,
            },
            { liveState: sessionState, liveError: null },
          ),
          encryptionConfigured: isSecretEncryptionConfigured(),
        },
        { status: 200 },
      );
    } catch (error: unknown) {
      const now = new Date();
      const message =
        error instanceof KanwapApiError
          ? error.message
          : "No se pudo validar la sesión de KanWap";

      await docRef.set(
        {
          [KANWAP_FIELD]: {
            lastValidatedAt: now,
            lastValidationError: message,
          },
        },
        { merge: true },
      );

      return NextResponse.json(
        {
          success: true,
          data: mapPublicConfig(config, { liveError: message }),
          encryptionConfigured: isSecretEncryptionConfigured(),
        },
        { status: 200 },
      );
    }
  } catch (error: unknown) {
    return toRouteErrorResponse(error, "Error leyendo configuración de WhatsApp");
  }
}

export async function POST(request: NextRequest) {
  try {
    const adminContext = await requireAdminTeacher(request);
    const body = (await request.json()) as UpsertWhatsAppConfigRequest;
    const apiKey = asText(body.apiKey);
    const sessionId = asText(body.sessionId);

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "apiKey es requerido" },
        { status: 400 },
      );
    }
    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: "sessionId es requerido" },
        { status: 400 },
      );
    }

    if (!isSecretEncryptionConfigured()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "No hay secreto de cifrado configurado. Define KANWAP_CONFIG_SECRET o API_KEY_HASH_PEPPER en el entorno.",
        },
        { status: 500 },
      );
    }

    const [sessions, status] = await Promise.all([
      listKanwapSessions(apiKey),
      getKanwapSessionStatus(apiKey, sessionId),
    ]);
    const selectedSession = sessions.find((session) => session.id === sessionId);
    const now = new Date();
    const docRef = getAdminFirestore()
      .collection(ADMIN_INTEGRATIONS_COLLECTION)
      .doc(adminContext.uid);
    const currentSnap = await docRef.get();
    const currentConfig = parseStoredKanwapConfig(currentSnap.data()?.[KANWAP_FIELD]);
    const encryptedApiKey = encryptSecretText(apiKey);
    const sessionState = asText(status.estado) || selectedSession?.estado || "desconocida";
    const sessionName =
      selectedSession?.nombre ||
      asText(status.nombre) ||
      asText(body.sessionName) ||
      null;
    const phone =
      selectedSession?.telefono ||
      asText(status.telefono) ||
      asText(body.phone) ||
      null;

    await docRef.set(
      {
        [KANWAP_FIELD]: {
          provider: "kanwap",
          baseUrl: getKanwapBaseUrlForDisplay(),
          sessionId,
          sessionName,
          phone,
          sessionState,
          apiKeyMasked: maskSecret(apiKey),
          apiKeyEncrypted: encryptedApiKey,
          createdAt: currentConfig?.createdAt ?? now,
          updatedAt: now,
          updatedBy: adminContext.uid,
          lastValidatedAt: now,
          lastValidationError: null,
        },
      },
      { merge: true },
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          provider: "kanwap",
          baseUrl: getKanwapBaseUrlForDisplay(),
          sessionId,
          sessionName,
          phone,
          sessionState,
          apiKeyMasked: maskSecret(apiKey),
          createdAt: toIso(currentConfig?.createdAt ?? now),
          updatedAt: now.toISOString(),
          updatedBy: adminContext.uid,
          lastValidatedAt: now.toISOString(),
          lastValidationError: null,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    if (error instanceof KanwapApiError) {
      return kanwapErrorResponse(error);
    }
    return toRouteErrorResponse(error, "Error guardando configuración de WhatsApp");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const adminContext = await requireAdminTeacher(request);
    await getAdminFirestore()
      .collection(ADMIN_INTEGRATIONS_COLLECTION)
      .doc(adminContext.uid)
      .set(
        {
          [KANWAP_FIELD]: null,
          updatedAt: new Date(),
          updatedBy: adminContext.uid,
        },
        { merge: true },
      );

    return NextResponse.json(
      { success: true, message: "Conexión de WhatsApp removida" },
      { status: 200 },
    );
  } catch (error: unknown) {
    return toRouteErrorResponse(error, "Error eliminando configuración de WhatsApp");
  }
}
