import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  FINANCE_WEBHOOK_ARCHIVE_SCOPE,
  verifyIntegrationApiKey,
} from "@/lib/security/integration-api-keys";
import {
  archiveStudentAccount,
  StudentArchiveError,
} from "@/lib/server/student-archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPTED_EVENTS = new Set([
  "student.archived",
  "student.deactivated",
  "student.unenrolled",
  "alumno.archivado",
  "alumno.baja",
]);

type AnyRecord = Record<string, unknown>;

type NormalizedArchivePayload = {
  eventType?: string;
  eventId?: string;
  email?: string;
  studentId?: string;
  reason?: string;
};

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function pickText(source: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asText(source[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const normalized = header.trim();
  if (!normalized.toLowerCase().startsWith("bearer ")) return undefined;
  const token = normalized.slice(7).trim();
  return token || undefined;
}

function safeSecretMatch(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function normalizePayload(body: AnyRecord): NormalizedArchivePayload {
  const bodyData = asRecord(body.data) ?? {};
  const nestedStudent =
    asRecord(body.student) ??
    asRecord(body.alumno) ??
    asRecord(bodyData.student) ??
    asRecord(bodyData.alumno) ??
    {};

  const merged: AnyRecord = {
    ...body,
    ...bodyData,
    ...nestedStudent,
  };

  const eventType = pickText(merged, ["event", "eventType", "type"])?.toLowerCase();
  const email = pickText(merged, ["email", "correo", "mail"])?.toLowerCase();
  const studentId = pickText(merged, ["studentId", "alumnoId", "uid", "userId", "id"]);
  const reason =
    pickText(merged, ["reason", "motivo", "archiveReason", "bajaReason"]) ??
    "Baja recibida por integración";
  const eventId = pickText(merged, ["eventId", "webhookId", "idempotencyKey"]);

  return {
    eventType,
    eventId,
    email,
    studentId,
    reason,
  };
}

function isSupportedArchiveEvent(eventType?: string): boolean {
  if (!eventType) return true;
  if (ACCEPTED_EVENTS.has(eventType)) return true;
  return (
    (eventType.includes("student") || eventType.includes("alumno")) &&
    (eventType.includes("archiv") || eventType.includes("deactiv") || eventType.includes("baja"))
  );
}

export async function POST(request: NextRequest) {
  const providedSecret =
    asText(request.headers.get("x-webhook-secret")) ??
    asText(request.headers.get("x-api-key")) ??
    normalizeBearerToken(request.headers.get("authorization"));

  if (!providedSecret) {
    return NextResponse.json({ success: false, error: "No autorizado" }, { status: 401 });
  }

  let dynamicKeyAuthorized = false;
  try {
    const dynamicVerification = await verifyIntegrationApiKey({
      apiKey: providedSecret,
      requiredScope: FINANCE_WEBHOOK_ARCHIVE_SCOPE,
      updateLastUsed: true,
    });
    dynamicKeyAuthorized = dynamicVerification.valid;
  } catch (error: unknown) {
    console.error("No se pudo validar API key dinámica para webhook de baja:", error);
  }

  const fallbackSecret = asText(process.env.FINANCE_WEBHOOK_SECRET);
  const legacyAuthorized = fallbackSecret ? safeSecretMatch(fallbackSecret, providedSecret) : false;

  if (!dynamicKeyAuthorized && !legacyAuthorized) {
    return NextResponse.json({ success: false, error: "No autorizado" }, { status: 401 });
  }

  let jsonBody: unknown;
  try {
    jsonBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Payload JSON inválido" }, { status: 400 });
  }

  const body = asRecord(jsonBody);
  if (!body) {
    return NextResponse.json({ success: false, error: "El body debe ser un objeto JSON" }, { status: 400 });
  }

  const payload = normalizePayload(body);
  if (!isSupportedArchiveEvent(payload.eventType)) {
    return NextResponse.json(
      {
        success: true,
        ignored: true,
        reason: `Evento no manejado: ${payload.eventType}`,
      },
      { status: 202 },
    );
  }

  if (!payload.studentId && !payload.email) {
    return NextResponse.json(
      { success: false, error: "studentId/alumnoId o email/correo es requerido para dar de baja" },
      { status: 400 },
    );
  }

  try {
    const result = await archiveStudentAccount({
      uid: payload.studentId,
      email: payload.email,
      archivedBy: "finance-webhook",
      source: "finance-webhook",
      reason: payload.reason,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...result,
          eventType: payload.eventType ?? null,
          eventId: payload.eventId ?? null,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    if (error instanceof StudentArchiveError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status },
      );
    }
    console.error("Error procesando webhook de baja de alumno:", error);
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "No se pudo archivar el alumno desde el webhook";
    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 },
    );
  }
}
