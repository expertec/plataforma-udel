import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import type { ExamKind, GlobalExamTemplateStatus } from "@/lib/global-exams/types";
import {
  GLOBAL_EXAM_MAX_ATTEMPTS,
  GLOBAL_EXAM_PASS_SCORE,
  normalizeGlobalExamQuestions,
} from "@/lib/global-exams/types";
import { toGlobalExamTemplateRecord } from "@/lib/server/global-exams";
import {
  requireGlobalExamAccess,
  toGlobalExamRouteErrorResponse,
} from "@/lib/server/global-exams-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTemplateStatus(value: unknown): GlobalExamTemplateStatus {
  return value === "published" ? "published" : "draft";
}

function normalizeExamKind(value: unknown): ExamKind {
  return value === "extraordinary" ? "extraordinary" : "global";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ templateId: string }> },
) {
  try {
    const access = await requireGlobalExamAccess(request, ["superAdminTeacher"]);
    const { templateId } = await context.params;
    const normalizedTemplateId = templateId.trim();
    if (!normalizedTemplateId) {
      return NextResponse.json(
        { success: false, error: "templateId es requerido" },
        { status: 400 },
      );
    }

    const db = getAdminFirestore();
    const templateRef = db.collection("globalExamTemplates").doc(normalizedTemplateId);
    const templateSnap = await templateRef.get();
    if (!templateSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro la plantilla solicitada" },
        { status: 404 },
      );
    }

    const sourceData = (templateSnap.data() ?? {}) as Record<string, unknown>;
    const now = new Date();
    const actorName = access.displayName || access.email || "SuperAdminTeacher";
    const sourceTitle = asTrimmedString(sourceData.title) || "Examen global";
    const questions = normalizeGlobalExamQuestions(sourceData.questions ?? []);
    const duplicatedRef = await db.collection("globalExamTemplates").add({
      examKind: normalizeExamKind(sourceData.examKind),
      title: `Copia de ${sourceTitle}`,
      description: asTrimmedString(sourceData.description),
      status: "draft",
      courseId: asTrimmedString(sourceData.courseId),
      courseName: asTrimmedString(sourceData.courseName),
      groupId: asTrimmedString(sourceData.groupId),
      passScore: asFiniteNumber(sourceData.passScore, GLOBAL_EXAM_PASS_SCORE),
      maxAttempts: asFiniteNumber(sourceData.maxAttempts, GLOBAL_EXAM_MAX_ATTEMPTS),
      questionCount: questions.length,
      questions,
      createdById: access.uid,
      createdByName: actorName,
      updatedById: access.uid,
      updatedByName: actorName,
      duplicatedFromTemplateId: normalizedTemplateId,
      duplicatedAt: now,
      duplicatedById: access.uid,
      duplicatedByName: actorName,
      createdAt: now,
      updatedAt: now,
    });

    const duplicatedSnap = await duplicatedRef.get();
    return NextResponse.json({
      success: true,
      data: toGlobalExamTemplateRecord(duplicatedRef.id, duplicatedSnap.data() ?? {}),
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error duplicando plantilla de examen global");
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ templateId: string }> },
) {
  try {
    const access = await requireGlobalExamAccess(request, ["adminTeacher", "superAdminTeacher"]);
    const { templateId } = await context.params;
    const normalizedTemplateId = templateId.trim();
    if (!normalizedTemplateId) {
      return NextResponse.json(
        { success: false, error: "templateId es requerido" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      examKind?: unknown;
      description?: unknown;
      courseId?: unknown;
      courseName?: unknown;
      status?: unknown;
      questions?: unknown;
    };

    const updates: Record<string, unknown> = {
      updatedById: access.uid,
      updatedByName: access.displayName || access.email || "AdminTeacher",
      updatedAt: new Date(),
    };

    if (body.title !== undefined) {
      const title = asTrimmedString(body.title);
      if (!title) {
        return NextResponse.json(
          { success: false, error: "El titulo no puede estar vacio" },
          { status: 400 },
        );
      }
      updates.title = title;
    }

    if (body.examKind !== undefined) {
      updates.examKind = normalizeExamKind(body.examKind);
    }

    if (body.description !== undefined) {
      updates.description = asTrimmedString(body.description);
    }

    if (body.status !== undefined) {
      updates.status = normalizeTemplateStatus(body.status);
    }

    if (body.courseId !== undefined) {
      const requestedCourseId = asTrimmedString(body.courseId);
      let requestedCourseName = asTrimmedString(body.courseName);

      if (requestedCourseId) {
        const courseSnap = await getAdminFirestore().collection("courses").doc(requestedCourseId).get();
        if (!courseSnap.exists) {
          return NextResponse.json(
            { success: false, error: "No se encontro la materia seleccionada" },
            { status: 404 },
          );
        }
        if (!requestedCourseName) {
          requestedCourseName = asTrimmedString(courseSnap.data()?.title) || "Materia";
        }
      } else {
        requestedCourseName = "";
      }

      updates.courseId = requestedCourseId;
      updates.courseName = requestedCourseName;
    } else if (body.courseName !== undefined) {
      updates.courseName = asTrimmedString(body.courseName);
    }

    if (body.questions !== undefined) {
      const questions = normalizeGlobalExamQuestions(body.questions);
      updates.questions = questions;
      updates.questionCount = questions.length;
    }

    const templateRef = getAdminFirestore().collection("globalExamTemplates").doc(normalizedTemplateId);
    const templateSnap = await templateRef.get();
    if (!templateSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro la plantilla solicitada" },
        { status: 404 },
      );
    }

    await templateRef.set(updates, { merge: true });
    const nextSnap = await templateRef.get();
    return NextResponse.json({
      success: true,
      data: toGlobalExamTemplateRecord(normalizedTemplateId, nextSnap.data() ?? {}),
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error actualizando plantilla de examen global");
  }
}
