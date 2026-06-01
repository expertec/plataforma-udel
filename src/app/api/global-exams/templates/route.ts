import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  GLOBAL_EXAM_MAX_ATTEMPTS,
  GLOBAL_EXAM_PASS_SCORE,
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

export async function GET(request: NextRequest) {
  try {
    const access = await requireGlobalExamAccess(request, [
      "coordinadorPlantel",
      "adminTeacher",
      "superAdminTeacher",
    ]);

    const templates = await getGlobalExamTemplates();
    const visibleTemplates = isGlobalExamAdminRole(access.role)
      ? templates
      : templates.filter((template) => template.status === "published");

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
    const access = await requireGlobalExamAccess(request, ["adminTeacher", "superAdminTeacher"]);
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      description?: unknown;
      courseId?: unknown;
      courseName?: unknown;
      status?: unknown;
      questions?: unknown;
    };

    const title = asTrimmedString(body.title);
    const description = asTrimmedString(body.description);
    const courseId = asTrimmedString(body.courseId);
    let courseName = asTrimmedString(body.courseName);
    const status = normalizeTemplateStatus(body.status);
    const questions = normalizeGlobalExamQuestions(body.questions);

    if (!title) {
      return NextResponse.json(
        { success: false, error: "El titulo del examen es requerido" },
        { status: 400 },
      );
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
      title,
      description,
      status,
      courseId,
      courseName,
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
