import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { resolveCourseManagementAccess } from "@/lib/server/course-management-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asTeacherRole(value: unknown): TeacherRole | null {
  if (
    value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel" ||
    value === "director"
  ) {
    return value;
  }
  return null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeClassType(value: unknown) {
  if (
    value === "video" ||
    value === "text" ||
    value === "audio" ||
    value === "quiz" ||
    value === "image" ||
    value === "live"
  ) {
    return value;
  }
  throw new RouteAccessError(400, "type inválido");
}

function normalizeQuestionType(value: unknown) {
  if (value === "multiple" || value === "truefalse" || value === "open") return value;
  return "multiple";
}

function normalizePointValue(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number(typeof value === "string" ? value.trim().replace(",", ".") : value);
  if (!Number.isFinite(parsed)) return 1;
  const bounded = Math.max(0, Math.min(parsed, 100));
  return Math.round(bounded * 100) / 100;
}

async function resolveTeacherContext(request: NextRequest): Promise<{ uid: string; role: TeacherRole }> {
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

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const roleFromDoc = asTeacherRole(userSnap.data()?.role);
  const roleFromClaims = asTeacherRole(decodedToken.role);
  const role = roleFromDoc ?? roleFromClaims;
  if (!role) {
    throw new RouteAccessError(403, "Acceso restringido a docentes");
  }

  return { uid, role };
}

async function canUserManageCourse(params: {
  courseId: string;
  uid: string;
  role: TeacherRole;
}): Promise<boolean> {
  const access = await resolveCourseManagementAccess({
    ...params,
    AccessError: RouteAccessError,
  });
  return access.allowed;
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error gestionando preguntas de quiz vía API segura", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ courseId: string; lessonId: string; classId: string }> },
) {
  try {
    const { courseId, lessonId, classId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    const normalizedLessonId = asTrimmedString(lessonId);
    const normalizedClassId = asTrimmedString(classId);
    if (!normalizedCourseId || !normalizedLessonId || !normalizedClassId) {
      throw new RouteAccessError(400, "courseId, lessonId o classId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RouteAccessError(400, "Body inválido");
    }

    const courseAllowed = await canUserManageCourse({
      courseId: normalizedCourseId,
      uid: teacherContext.uid,
      role: teacherContext.role,
    });
    if (!courseAllowed) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    const prompt = asTrimmedString(body.prompt);
    if (!prompt) {
      throw new RouteAccessError(400, "prompt es requerido");
    }

    const options = Array.isArray(body.options)
      ? body.options.map((option, index) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            throw new RouteAccessError(400, `options[${index}] inválido`);
          }
          const optionRecord = option as Record<string, unknown>;
          return {
            id: asTrimmedString(optionRecord.id) || `option-${index + 1}`,
            text: asTrimmedString(optionRecord.text),
            isCorrect: optionRecord.isCorrect === true,
            feedback: asTrimmedString(optionRecord.feedback),
            correctFeedback: asTrimmedString(optionRecord.correctFeedback),
            incorrectFeedback: asTrimmedString(optionRecord.incorrectFeedback),
          };
        })
      : [];

    const db = getAdminFirestore();
    const classRef = db
      .collection("courses")
      .doc(normalizedCourseId)
      .collection("lessons")
      .doc(normalizedLessonId)
      .collection("classes")
      .doc(normalizedClassId);
    const classSnap = await classRef.get();
    if (!classSnap.exists) {
      throw new RouteAccessError(404, "Clase no encontrada");
    }
    const classData = classSnap.data() ?? {};
    const classType = normalizeClassType(classData.type);
    if (classType !== "quiz") {
      throw new RouteAccessError(400, "La clase no es un quiz");
    }

    const questionRef = classRef.collection("questions").doc();
    await questionRef.set({
      prompt,
      explanation:
        body.explanation === undefined || body.explanation === null
          ? null
          : asTrimmedString(body.explanation),
      type: normalizeQuestionType(body.type),
      options,
      order: typeof body.order === "number" ? body.order : 0,
      pointValue: normalizePointValue(body.pointValue),
      answerText:
        body.answerText === undefined || body.answerText === null
          ? null
          : asTrimmedString(body.answerText),
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          questionId: questionRef.id,
        },
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
