import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { sendWhatsAppTextToStudent } from "@/lib/server/whatsapp-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole = "teacher" | "adminTeacher" | "superAdminTeacher";

type GradeNotificationRequest = {
  groupId?: string;
  submissionId?: string;
  grade?: number;
};

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTeacherRole(value: unknown): TeacherRole | null {
  if (value === "teacher" || value === "adminTeacher" || value === "superAdminTeacher") {
    return value;
  }
  return null;
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function normalizeGrade(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RouteAccessError(400, "grade debe ser numérico");
  }
  if (value < 0 || value > 100) {
    throw new RouteAccessError(400, "grade debe estar entre 0 y 100");
  }
  return Math.round(value * 100) / 100;
}

async function resolveRequester(request: NextRequest): Promise<{
  uid: string;
  role: TeacherRole;
  displayName: string;
}> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const db = getAdminFirestore();
  const uid = decodedToken.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  const roleFromDoc = asTeacherRole(userSnap.data()?.role);
  const roleFromClaims = asTeacherRole(decodedToken.role);
  const role = roleFromDoc ?? roleFromClaims;
  if (!role) {
    throw new RouteAccessError(403, "Acceso restringido a docentes");
  }

  const displayName =
    asText(userSnap.data()?.name) ||
    asText(userSnap.data()?.displayName) ||
    asText(decodedToken.name) ||
    "Tu profesor";

  return {
    uid,
    role,
    displayName,
  };
}

async function ensureCanGradeGroup(params: {
  uid: string;
  role: TeacherRole;
  groupId: string;
}): Promise<void> {
  if (params.role === "adminTeacher" || params.role === "superAdminTeacher") {
    return;
  }

  const groupSnap = await getAdminFirestore().collection("groups").doc(params.groupId).get();
  if (!groupSnap.exists) {
    throw new RouteAccessError(404, "Grupo no encontrado");
  }
  const groupData = groupSnap.data() ?? {};
  const mainTeacherId = asText(groupData.teacherId);
  const assistantTeacherIds = Array.isArray(groupData.assistantTeacherIds)
    ? groupData.assistantTeacherIds
        .map((item) => asText(item))
        .filter(Boolean)
    : [];
  if (mainTeacherId === params.uid || assistantTeacherIds.includes(params.uid)) {
    return;
  }

  throw new RouteAccessError(403, "No tienes permisos para notificar en este grupo");
}

function buildGradeMessage(params: {
  teacherName: string;
  grade: number;
  className: string;
  courseTitle?: string;
  lessonTitle?: string;
}): string {
  const teacherName = params.teacherName || "Tu profesor";
  const className = params.className || "actividad";
  const contextParts = [params.courseTitle, params.lessonTitle]
    .map((part) => asText(part))
    .filter(Boolean);
  const contextText = contextParts.length ? contextParts.join(" • ") : "";
  const contextLine = contextText ? `\n📚 Contexto: ${contextText}` : "";

  return (
    `✅ *Nueva calificación registrada*\n` +
    `\n` +
    `👨‍🏫 Profesor: ${teacherName}\n` +
    `📝 Actividad: ${className}${contextLine}\n` +
    `⭐ Calificación: *${params.grade}/100*\n` +
    `\n` +
    `Revisa los detalles y la retroalimentación en la plataforma.\n` +
    `\n` +
    `⏳ Tienes hasta *5 días* después de haber recibido tu calificación.\n` +
    `Si detectas un error, comunícate con tu maestro o repórtalo en *Experiencia del Alumno*.\n` +
    `📞 (782) 101 2431`
  );
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }
  console.error("Error notificando calificación por WhatsApp", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function POST(request: NextRequest) {
  try {
    const requester = await resolveRequester(request);
    const body = (await request.json()) as GradeNotificationRequest;
    const groupId = asText(body.groupId);
    const submissionId = asText(body.submissionId);
    const grade = normalizeGrade(body.grade);
    if (!groupId) {
      throw new RouteAccessError(400, "groupId es requerido");
    }
    if (!submissionId) {
      throw new RouteAccessError(400, "submissionId es requerido");
    }

    await ensureCanGradeGroup({
      uid: requester.uid,
      role: requester.role,
      groupId,
    });

    const db = getAdminFirestore();
    const submissionSnap = await db
      .collection("groups")
      .doc(groupId)
      .collection("submissions")
      .doc(submissionId)
      .get();
    if (!submissionSnap.exists) {
      throw new RouteAccessError(404, "Submission no encontrada");
    }
    const submissionData = submissionSnap.data() ?? {};
    const studentId = asText(submissionData.studentId);
    if (!studentId) {
      throw new RouteAccessError(400, "La submission no tiene studentId");
    }

    const message = buildGradeMessage({
      teacherName: requester.displayName,
      grade,
      className: asText(submissionData.className) || "actividad",
      courseTitle: asText(submissionData.courseTitle) || undefined,
      lessonTitle: asText(submissionData.lessonTitle) || undefined,
    });

    const outcome = await sendWhatsAppTextToStudent({
      studentId,
      groupId,
      message,
      preferredOwnerUid: requester.uid,
    });

    return NextResponse.json(
      {
        success: true,
        data: outcome,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
