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
  program?: string;
  programId?: string;
  groupId?: string;
  groupIds?: string[];
  groupName?: string;
  externalId?: string;
  updatePasswordIfExists: boolean;
};

type GroupEnrollmentResult = {
  groupId: string;
  groupName: string;
  enrollmentId: string;
  alreadyEnrolled: boolean;
  groupProgram?: string;
  courseId?: string;
  courseName?: string;
};

class WebhookRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
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
  const bodyGroup =
    asRecord(body.group) ??
    asRecord(body.grupo) ??
    asRecord(bodyData.group) ??
    asRecord(bodyData.grupo) ??
    {};
  const bodyProgram =
    asRecord(body.program) ??
    asRecord(body.programa) ??
    asRecord(bodyData.program) ??
    asRecord(bodyData.programa) ??
    {};
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
    pickText(bodyProgram, ["name", "nombre", "program", "programa"]) ??
    pickText(merged, ["program", "programa", "career", "carrera", "campus", "plantel"]) ??
    undefined;
  const programId =
    pickText(bodyProgram, ["id", "programId", "programaId", "program_id"]) ??
    pickText(merged, ["programId", "programaId", "program_id"]);
  const groupId =
    pickText(bodyGroup, ["id", "groupId", "grupoId", "group_id"]) ??
    pickText(merged, ["groupId", "grupoId", "group_id"]) ??
    asText(process.env.FINANCE_WEBHOOK_DEFAULT_GROUP_ID);
  const groupIds = asStringArray(merged.groupIds ?? merged.grupoIds ?? bodyGroup.groupIds);
  const groupName =
    pickText(bodyGroup, ["name", "groupName", "grupoNombre", "nombreGrupo"]) ??
    pickText(merged, ["groupName", "grupoNombre", "nombreGrupo", "group", "grupo"]) ??
    asText(process.env.FINANCE_WEBHOOK_DEFAULT_GROUP_NAME);
  if (groupId && !groupIds.includes(groupId)) {
    groupIds.unshift(groupId);
  }
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
    programId,
    groupId,
    groupIds,
    groupName,
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

async function resolveProgramNameById(params: {
  firestore: ReturnType<typeof getAdminFirestore>;
  programId: string;
}): Promise<string> {
  const trimmedProgramId = params.programId.trim();
  if (!trimmedProgramId) {
    throw new WebhookRequestError(400, "programId inválido");
  }
  const programRef = params.firestore.collection("programs").doc(trimmedProgramId);
  const programSnap = await programRef.get();
  if (!programSnap.exists) {
    throw new WebhookRequestError(400, `No existe programa con id ${trimmedProgramId}`);
  }
  const programName = asText(programSnap.data()?.name);
  if (!programName) {
    throw new WebhookRequestError(400, `El programa ${trimmedProgramId} no tiene nombre válido`);
  }
  return programName;
}

async function resolveGroupIdFromPayload(params: {
  firestore: ReturnType<typeof getAdminFirestore>;
  groupId?: string;
  groupIds?: string[];
  groupName?: string;
  programName?: string;
}): Promise<string | undefined> {
  const directGroupId = params.groupId?.trim();
  if (directGroupId) {
    return directGroupId;
  }

  const groupIds = (params.groupIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (groupIds.length > 0) {
    return groupIds[0];
  }

  const trimmedGroupName = params.groupName?.trim();
  if (!trimmedGroupName) {
    return undefined;
  }

  const byNameSnap = await params.firestore
    .collection("groups")
    .where("groupName", "==", trimmedGroupName)
    .limit(10)
    .get();

  if (byNameSnap.empty) {
    throw new WebhookRequestError(400, `No existe grupo con nombre ${trimmedGroupName}`);
  }

  if (byNameSnap.size === 1) {
    return byNameSnap.docs[0]?.id;
  }

  const normalizedProgram = params.programName?.trim().toLowerCase();
  if (normalizedProgram) {
    const matchesByProgram = byNameSnap.docs.filter((docSnap) => {
      const groupProgram = asText(docSnap.data()?.program);
      return (groupProgram ?? "").trim().toLowerCase() === normalizedProgram;
    });
    if (matchesByProgram.length === 1) {
      return matchesByProgram[0]?.id;
    }
  }

  throw new WebhookRequestError(
    409,
    `Hay ${byNameSnap.size} grupos con nombre ${trimmedGroupName}. Envía groupId para evitar ambigüedad.`,
  );
}

function resolvePrimaryCourse(groupData: AnyRecord): { courseId: string; courseName: string } {
  let courseId = asText(groupData.courseId) ?? "";
  let courseName = asText(groupData.courseName) ?? "";

  if (!courseId) {
    const courseIds = asStringArray(groupData.courseIds);
    if (courseIds.length > 0) {
      courseId = courseIds[0] ?? "";
    }
  }

  if (!courseId && Array.isArray(groupData.courses)) {
    for (const value of groupData.courses) {
      const course = asRecord(value);
      const candidateId = course ? asText(course.courseId) : undefined;
      if (!candidateId) continue;
      courseId = candidateId;
      if (!courseName) {
        courseName = asText(course?.courseName) ?? "";
      }
      break;
    }
  }

  if (!courseName && courseId && Array.isArray(groupData.courses)) {
    for (const value of groupData.courses) {
      const course = asRecord(value);
      if (!course) continue;
      if (asText(course.courseId) !== courseId) continue;
      courseName = asText(course.courseName) ?? "";
      break;
    }
  }

  return { courseId, courseName };
}

async function ensureStudentEnrollmentInGroup(params: {
  firestore: ReturnType<typeof getAdminFirestore>;
  groupId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
}): Promise<GroupEnrollmentResult> {
  const trimmedGroupId = params.groupId.trim();
  if (!trimmedGroupId) {
    throw new WebhookRequestError(400, "groupId inválido");
  }

  const groupRef = params.firestore.collection("groups").doc(trimmedGroupId);
  const groupStudentRef = groupRef.collection("students").doc(params.studentId);
  const enrollmentId = `${trimmedGroupId}_${params.studentId}`;
  const enrollmentRef = params.firestore.collection("studentEnrollments").doc(enrollmentId);

  let result: GroupEnrollmentResult | null = null;

  await params.firestore.runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      throw new WebhookRequestError(400, `No existe grupo con id ${trimmedGroupId}`);
    }

    const groupData = groupSnap.data() ?? {};
    const groupName = asText(groupData.groupName) ?? "";
    const groupStatus = (asText(groupData.status) ?? "active").toLowerCase();
    if (groupStatus !== "active") {
      throw new WebhookRequestError(409, `El grupo ${trimmedGroupId} no está activo`);
    }
    const { courseId, courseName } = resolvePrimaryCourse(groupData);
    const teacherName = asText(groupData.teacherName) ?? "";
    const groupProgram = asText(groupData.program);
    const maxStudents =
      typeof groupData.maxStudents === "number" && Number.isFinite(groupData.maxStudents)
        ? groupData.maxStudents
        : 0;
    const studentsCount =
      typeof groupData.studentsCount === "number" && Number.isFinite(groupData.studentsCount)
        ? groupData.studentsCount
        : 0;

    const groupStudentSnap = await tx.get(groupStudentRef);
    const enrollmentSnap = await tx.get(enrollmentRef);
    const alreadyInGroup = groupStudentSnap.exists;

    if (!alreadyInGroup && maxStudents > 0 && studentsCount >= maxStudents) {
      throw new WebhookRequestError(409, `El grupo ${trimmedGroupId} está lleno`);
    }

    const now = new Date();
    const groupStudentData: AnyRecord = {
      studentId: params.studentId,
      studentName: params.studentName,
      studentEmail: params.studentEmail,
      status: "active",
      updatedAt: now,
    };
    if (!groupStudentSnap.exists) {
      groupStudentData.enrolledAt = now;
    }
    tx.set(groupStudentRef, groupStudentData, { merge: true });

    const enrollmentData: AnyRecord = {
      studentId: params.studentId,
      studentName: params.studentName,
      studentEmail: params.studentEmail,
      groupId: trimmedGroupId,
      groupName,
      courseId,
      courseName,
      teacherName,
      status: "active",
      updatedAt: now,
    };
    if (groupProgram) {
      enrollmentData.program = groupProgram;
    }
    if (!enrollmentSnap.exists) {
      enrollmentData.enrolledAt = now;
      enrollmentData.finalGrade = null;
    }
    tx.set(enrollmentRef, enrollmentData, { merge: true });

    if (!alreadyInGroup) {
      tx.set(
        groupRef,
        {
          studentsCount: studentsCount + 1,
          updatedAt: now,
        },
        { merge: true },
      );
    }

    result = {
      groupId: trimmedGroupId,
      groupName,
      enrollmentId,
      alreadyEnrolled: alreadyInGroup,
      groupProgram: groupProgram ?? undefined,
      courseId,
      courseName,
    };
  });

  if (!result) {
    throw new WebhookRequestError(500, "No se pudo asignar al grupo");
  }

  return result;
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

    const resolvedProgramFromId = payload.programId
      ? await resolveProgramNameById({
          firestore,
          programId: payload.programId,
        })
      : undefined;
    const programFromPayload = payload.program?.trim() || undefined;

    const targetGroupId = await resolveGroupIdFromPayload({
      firestore,
      groupId: payload.groupId,
      groupIds: payload.groupIds,
      groupName: payload.groupName,
      programName: resolvedProgramFromId ?? programFromPayload,
    });
    const groupEnrollment = targetGroupId
      ? await ensureStudentEnrollmentInGroup({
          firestore,
          groupId: targetGroupId,
          studentId: userRecord.uid,
          studentName: normalizedName,
          studentEmail: normalizedEmail,
        })
      : null;

    const resolvedProgram =
      resolvedProgramFromId ||
      programFromPayload ||
      groupEnrollment?.groupProgram ||
      asText(process.env.FINANCE_WEBHOOK_DEFAULT_PROGRAM) ||
      "";

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
      program: resolvedProgram,
      source: "finance-webhook",
      updatedAt: now,
      updatedBy: "finance-webhook",
      financeWebhook: {
        eventType: payload.eventType ?? null,
        eventId: payload.eventId ?? null,
        externalId: payload.externalId ?? null,
        groupId: groupEnrollment?.groupId ?? targetGroupId ?? null,
        groupName: groupEnrollment?.groupName ?? payload.groupName ?? null,
        enrollmentId: groupEnrollment?.enrollmentId ?? null,
        groupAssigned: Boolean(groupEnrollment),
        syncedAt: now,
      },
    };
    if (payload.programId) {
      dataToPersist.programId = payload.programId;
    }

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
          program: resolvedProgram,
          programId: payload.programId ?? null,
          eventType: payload.eventType ?? null,
          eventId: payload.eventId ?? null,
          groupId: groupEnrollment?.groupId ?? null,
          groupName: groupEnrollment?.groupName ?? null,
          requestedGroupName: payload.groupName ?? null,
          enrollmentId: groupEnrollment?.enrollmentId ?? null,
          alreadyEnrolledInGroup: groupEnrollment?.alreadyEnrolled ?? null,
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    if (err instanceof WebhookRequestError) {
      return NextResponse.json(
        {
          success: false,
          error: err.message,
        },
        { status: err.status },
      );
    }
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
