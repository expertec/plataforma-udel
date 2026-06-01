import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import type { GlobalExamTemplateStatus } from "@/lib/global-exams/types";
import { normalizeGlobalExamQuestions } from "@/lib/global-exams/types";
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

function normalizeTemplateStatus(value: unknown): GlobalExamTemplateStatus {
  return value === "published" ? "published" : "draft";
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
