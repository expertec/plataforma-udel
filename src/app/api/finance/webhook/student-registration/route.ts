import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { UserRecord } from "firebase-admin/auth";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import {
  FINANCE_WEBHOOK_SCOPE,
  verifyIntegrationApiKey,
} from "@/lib/security/integration-api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPTED_EVENTS = new Set([
  "student.created",
  "student.registered",
  "alumno.creado",
  "alumno.registrado",
]);

type AnyRecord = Record<string, unknown>;

type NormalizedWebhookPayload = {
  eventType?: string;
  eventId?: string;
  email: string;
  password?: string;
  name: string;
  phone?: string;
  program: string;
  externalId?: string;
  updatePasswordIfExists: boolean;
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

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "si";
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

function normalizePayload(body: AnyRecord): NormalizedWebhookPayload {
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

  const email = (pickText(merged, ["email", "correo", "mail"]) ?? "").toLowerCase();
  const password = pickText(merged, ["password", "contrasena", "contraseña", "clave"]);
  const name =
    pickText(merged, ["name", "nombre", "fullName", "studentName", "alumnoNombre"]) ?? "Alumno";
  const phone = pickText(merged, ["phone", "telefono", "tel", "mobile", "celular"]);
  const program =
    pickText(merged, ["program", "programa", "career", "carrera", "campus", "plantel"]) ??
    asText(process.env.FINANCE_WEBHOOK_DEFAULT_PROGRAM) ??
    "";
  const rawEventType = pickText(merged, ["event", "eventType", "type"]);
  const eventType = rawEventType?.toLowerCase();
  const eventId = pickText(merged, ["eventId", "webhookId", "idempotencyKey"]);
  const externalId = pickText(merged, ["externalId", "studentId", "alumnoId", "customerId"]);
  const updatePasswordIfExists = asBoolean(merged.updatePasswordIfExists);

  return {
    eventType,
    eventId,
    email,
    password,
    name,
    phone,
    program,
    externalId,
    updatePasswordIfExists,
  };
}

async function getOrCreateUser(
  params: Pick<NormalizedWebhookPayload, "email" | "password" | "name">,
): Promise<{ userRecord: UserRecord; created: boolean }> {
  const auth = getAdminAuth();
  const normalizedEmail = params.email.trim().toLowerCase();
  const password = params.password;

  try {
    const existing = await auth.getUserByEmail(normalizedEmail);
    return { userRecord: existing, created: false };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== "auth/user-not-found") throw err;
  }

  try {
    const created = await getAdminAuth().createUser({
      email: normalizedEmail,
      password: password!,
      displayName: params.name,
    });
    return { userRecord: created, created: true };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== "auth/email-already-exists") throw err;
    const existing = await getAdminAuth().getUserByEmail(normalizedEmail);
    return { userRecord: existing, created: false };
  }
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
      requiredScope: FINANCE_WEBHOOK_SCOPE,
      updateLastUsed: true,
    });
    dynamicKeyAuthorized = dynamicVerification.valid;
  } catch (error: unknown) {
    // Mantener fallback con FINANCE_WEBHOOK_SECRET durante la migración.
    console.error("No se pudo validar API key dinámica para webhook de finanzas:", error);
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

  if (
    payload.eventType &&
    !ACCEPTED_EVENTS.has(payload.eventType) &&
    !payload.eventType.includes("student") &&
    !payload.eventType.includes("alumno")
  ) {
    return NextResponse.json(
      {
        success: true,
        ignored: true,
        reason: `Evento no manejado: ${payload.eventType}`,
      },
      { status: 202 },
    );
  }

  if (!payload.email) {
    return NextResponse.json(
      { success: false, error: "email/correo es requerido para crear el alumno" },
      { status: 400 },
    );
  }

  const resolvedPassword = payload.password ?? asText(process.env.FINANCE_WEBHOOK_DEFAULT_PASSWORD);
  if (!resolvedPassword) {
    return NextResponse.json(
      {
        success: false,
        error: "password es requerido (o configura FINANCE_WEBHOOK_DEFAULT_PASSWORD)",
      },
      { status: 400 },
    );
  }

  if (resolvedPassword.length < 6) {
    return NextResponse.json(
      { success: false, error: "La contraseña debe tener al menos 6 caracteres" },
      { status: 400 },
    );
  }

  try {
    const normalizedEmail = payload.email.trim().toLowerCase();
    const normalizedName = payload.name.trim() || "Alumno";
    const auth = getAdminAuth();
    const firestore = getAdminFirestore();

    const { userRecord, created } = await getOrCreateUser({
      email: normalizedEmail,
      password: resolvedPassword,
      name: normalizedName,
    });

    const userDocRef = firestore.collection("users").doc(userRecord.uid);
    const existingUserDoc = await userDocRef.get();
    const existingRole = asText(existingUserDoc.data()?.role) ?? asText(userRecord.customClaims?.role);

    if (existingRole && existingRole !== "student") {
      return NextResponse.json(
        {
          success: false,
          error: `El correo ya pertenece a un usuario con rol ${existingRole}`,
        },
        { status: 409 },
      );
    }

    if (!created) {
      const authUpdate: { displayName?: string; password?: string } = {};
      if ((userRecord.displayName ?? "") !== normalizedName) {
        authUpdate.displayName = normalizedName;
      }
      if (payload.updatePasswordIfExists) {
        authUpdate.password = resolvedPassword;
      }
      if (Object.keys(authUpdate).length > 0) {
        await auth.updateUser(userRecord.uid, authUpdate);
      }
    }

    const existingClaims = userRecord.customClaims ?? {};
    if (existingClaims.role !== "student") {
      await auth.setCustomUserClaims(userRecord.uid, {
        ...existingClaims,
        role: "student",
      });
    }

    const now = new Date();
    const dataToPersist: AnyRecord = {
      email: normalizedEmail,
      displayName: normalizedName,
      name: normalizedName,
      role: "student",
      status: "active",
      provider: "password",
      mustChangePassword: true,
      phone: payload.phone ?? null,
      program: payload.program,
      source: "finance-webhook",
      updatedAt: now,
      updatedBy: "finance-webhook",
      financeWebhook: {
        eventType: payload.eventType ?? null,
        eventId: payload.eventId ?? null,
        externalId: payload.externalId ?? null,
        syncedAt: now,
      },
    };

    if (created) {
      dataToPersist.createdAt = now;
      dataToPersist.createdBy = "finance-webhook";
    }

    await userDocRef.set(dataToPersist, { merge: true });

    return NextResponse.json(
      {
        success: true,
        data: {
          uid: userRecord.uid,
          email: normalizedEmail,
          created,
          passwordSource: payload.password ? "payload" : "default",
          eventType: payload.eventType ?? null,
          eventId: payload.eventId ?? null,
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("Error procesando webhook de registro de alumnos:", err);
    return NextResponse.json(
      {
        success: false,
        error: "No se pudo sincronizar el alumno desde el webhook",
      },
      { status: 500 },
    );
  }
}
