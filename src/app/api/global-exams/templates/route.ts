import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  GLOBAL_EXAM_MAX_ATTEMPTS,
  GLOBAL_EXAM_PASS_SCORE,
  type ExamKind,
  type GlobalExamTemplateStatus,
  normalizeGlobalExamQuestions,
} from "@/lib/global-exams/types";
import {
  getGlobalExamTemplates,
  toGlobalExamTemplateRecord,
} from "@/lib/server/global-exams";
import {
  isGlobalExamAdminRole,
  requireGlobalExamAccess,
  toGlobalExamRouteErrorResponse,
} from "@/lib/server/global-exams-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTemplateStatus(value: unknown): GlobalExamTemplateStatus {
  return value === "published" ? "published" : "draft";
}

function normalizeExamKind(value: unknown): ExamKind {
  return value === "extraordinary" ? "extraordinary" : "global";
}

async function requireTeacherTemplateAccess(params: {
  uid: string;
  groupId: string;
  courseId: string;
}) {
  const { uid, groupId, courseId } = params;
  if (!groupId || !courseId) {
    return NextResponse.json(
      { success: false, error: "groupId y courseId son requeridos para profesores" },
      { status: 400 },
    );
  }

  const groupSnap = await getAdminFirestore().collection("groups").doc(groupId).get();
  if (!groupSnap.exists) {
    return NextResponse.json({ success: false, error: "Grupo no encontrado" }, { status: 404 });
  }

  const groupData = groupSnap.data() ?? {};
  const teacherId = asTrimmedString(groupData.teacherId);
  const assistantTeacherIds = Array.isArray(groupData.assistantTeacherIds)
    ? groupData.assistantTeacherIds
        .map((value) => asTrimmedString(value))
        .filter((value) => value.length > 0)
    : [];
  const courses = Array.isArray(groupData.courses) ? groupData.courses : [];
  const courseInGroup =
    asTrimmedString(groupData.courseId) === courseId ||
    courses.some((entry) => entry && typeof entry === "object" && asTrimmedString((entry as { courseId?: unknown }).courseId) === courseId);

  if ((teacherId !== uid && !assistantTeacherIds.includes(uid)) || !courseInGroup) {
    return NextResponse.json(
      { success: false, error: "Missing or insufficient permissions." },
      { status: 403 },
    );
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    const access = await requireGlobalExamAccess(request, [
      "coordinadorPlantel",
      "director",
      "adminTeacher",
      "superAdminTeacher",
    ]);

    const requestedExamKind = new URL(request.url).searchParams.get("examKind")?.trim() ?? "global";
    const templates = await getGlobalExamTemplates();
    const kindFilteredTemplates =
      requestedExamKind === "all"
        ? templates
        : templates.filter((template) =>
            requestedExamKind === "extraordinary"
              ? template.examKind === "extraordinary"
              : template.examKind === "global",
          );
    const visibleTemplates = isGlobalExamAdminRole(access.role)
      ? kindFilteredTemplates
      : kindFilteredTemplates.filter((template) => template.status === "published");

    return NextResponse.json({
      success: true,
      data: visibleTemplates,
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error listando plantillas de examen global");
  }
}

export async function POST(request: NextRequest) {
  try {
    const access = await requireGlobalExamAccess(request, ["teacher", "adminTeacher", "superAdminTeacher"]);
    const body = (await request.json().catch(() => ({}))) as {
      examKind?: unknown;
      title?: unknown;
      description?: unknown;
      courseId?: unknown;
      courseName?: unknown;
      groupId?: unknown;
      status?: unknown;
      questions?: unknown;
    };

    const examKind = normalizeExamKind(body.examKind);
    const title = asTrimmedString(body.title);
    const description = asTrimmedString(body.description);
    const courseId = asTrimmedString(body.courseId);
    let courseName = asTrimmedString(body.courseName);
    const groupId = asTrimmedString(body.groupId);
    const status = normalizeTemplateStatus(body.status);
    const questions = normalizeGlobalExamQuestions(body.questions);

    if (!title) {
      return NextResponse.json(
        { success: false, error: "El titulo del examen es requerido" },
        { status: 400 },
      );
    }

    if (access.role === "teacher") {
      if (examKind !== "extraordinary") {
        return NextResponse.json(
          { success: false, error: "Los profesores solo pueden crear plantillas de examen extraordinario" },
          { status: 403 },
        );
      }
      const teacherAccessError = await requireTeacherTemplateAccess({
        uid: access.uid,
        groupId,
        courseId,
      });
      if (teacherAccessError) return teacherAccessError;
    }

    const db = getAdminFirestore();
    if (courseId) {
      const courseSnap = await db.collection("courses").doc(courseId).get();
      if (!courseSnap.exists) {
        return NextResponse.json(
          { success: false, error: "No se encontro la materia seleccionada" },
          { status: 404 },
        );
      }

      if (!courseName) {
        courseName = asTrimmedString(courseSnap.data()?.title) || "Materia";
      }
    } else {
      courseName = "";
    }

    const now = new Date();
    const createdByName = access.displayName || access.email || "AdminTeacher";
    const docRef = await db.collection("globalExamTemplates").add({
      examKind,
      title,
      description,
      status,
      courseId,
      courseName,
      groupId,
      passScore: GLOBAL_EXAM_PASS_SCORE,
      maxAttempts: GLOBAL_EXAM_MAX_ATTEMPTS,
      questionCount: questions.length,
      questions,
      createdById: access.uid,
      createdByName,
      updatedById: access.uid,
      updatedByName: createdByName,
      createdAt: now,
      updatedAt: now,
    });

    const createdSnap = await docRef.get();
    return NextResponse.json({
      success: true,
      data: toGlobalExamTemplateRecord(docRef.id, createdSnap.data() ?? {}),
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error creando plantilla de examen global");
  }
}
