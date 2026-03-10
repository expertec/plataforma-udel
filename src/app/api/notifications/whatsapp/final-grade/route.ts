import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { sendWhatsAppTextToStudent } from "@/lib/server/whatsapp-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel";

type FinalGradeNotificationRequest = {
  groupId?: string;
  studentId?: string;
  courseId?: string;
  finalGrade?: number;
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
  if (
    value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel"
  ) {
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
    throw new RouteAccessError(400, "finalGrade debe ser numérico");
  }
  if (value < 0 || value > 100) {
    throw new RouteAccessError(400, "finalGrade debe estar entre 0 y 100");
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

async function ensureCanManageGroup(params: {
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

function buildFinalGradeMessage(params: {
  teacherName: string;
  finalGrade: number;
  courseName: string;
}): string {
  const teacherName = params.teacherName || "Tu profesor";
  const courseName = params.courseName || "esta materia";
  return (
    `🎓 *Calificación final registrada*\n` +
    `\n` +
    `👨‍🏫 Profesor: ${teacherName}\n` +
    `📘 Materia: ${courseName}\n` +
    `⭐ Calificación final: *${params.finalGrade}/100*\n` +
    `\n` +
    `La materia se cerrará más adelante.\n` +
    `Puedes revisar tu avance en la plataforma.\n` +
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
  console.error("Error notificando calificación final por WhatsApp", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function POST(request: NextRequest) {
  try {
    const requester = await resolveRequester(request);
    const body = (await request.json()) as FinalGradeNotificationRequest;
    const groupId = asText(body.groupId);
    const studentId = asText(body.studentId);
    const courseId = asText(body.courseId);
    const finalGrade = normalizeGrade(body.finalGrade);
    if (!groupId) {
      throw new RouteAccessError(400, "groupId es requerido");
    }
    if (!studentId) {
      throw new RouteAccessError(400, "studentId es requerido");
    }
    if (!courseId) {
      throw new RouteAccessError(400, "courseId es requerido");
    }

    await ensureCanManageGroup({
      uid: requester.uid,
      role: requester.role,
      groupId,
    });

    const courseSnap = await getAdminFirestore().collection("courses").doc(courseId).get();
    const courseName = asText(courseSnap.data()?.title) || "Materia";

    const outcome = await sendWhatsAppTextToStudent({
      studentId,
      groupId,
      preferredOwnerUid: requester.uid,
      message: buildFinalGradeMessage({
        teacherName: requester.displayName,
        finalGrade,
        courseName,
      }),
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
