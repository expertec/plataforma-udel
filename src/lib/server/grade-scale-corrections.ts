import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { TeacherAccessError, type TeacherAccessContext } from "@/lib/server/require-teacher-access";
import { canReviewGradeGroup, gradeScalePolicy } from "@/lib/server/grade-scale-access";
import { analyzeEnrollmentGradeScale, enrollmentGradeClosures, gradeAnalysisIsoDate, type GradeCorrection } from "@/lib/students/grade-scale-analysis";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function parseGradeCorrection(input: unknown) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const source = text(body.source);
  const enrollmentId = text(body.enrollmentId), courseId = text(body.courseId);
  const requestId = text(body.requestId), reason = text(body.reason), revision = text(body.revision);
  if (!["studentEnrollments", "studentEnrollmentsArchive"].includes(source) ||
    [enrollmentId, courseId].some(id => !id || id.includes("/") || id.length > 1500) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId) || !/^\d+:\d+$/.test(revision)) {
    throw new TeacherAccessError(400, "La referencia de la calificación no es válida. Actualiza el análisis.");
  }
  if (typeof body.newGrade !== "number" || !Number.isFinite(body.newGrade) || body.newGrade < 0 || body.newGrade > 100 ||
    Math.abs(body.newGrade * 100 - Math.round(body.newGrade * 100)) > 0.000001) {
    throw new TeacherAccessError(400, "La nota debe estar entre 0 y 100, con hasta dos decimales.");
  }
  if (reason.length < 10 || reason.length > 2000) throw new TeacherAccessError(400, "Explica el motivo de la corrección en 10 a 2000 caracteres.");
  return { source: source as GradeCorrection["source"], enrollmentId, courseId, requestId, reason, revision, newGrade: body.newGrade };
}

export function serializeGradeCorrection(id: string, data: Record<string, unknown>): GradeCorrection {
  return {
    id, source: data.source as GradeCorrection["source"], enrollmentId: text(data.enrollmentId),
    studentId: text(data.studentId), studentName: text(data.studentName), groupId: text(data.groupId),
    groupName: text(data.groupName), courseId: text(data.courseId), courseName: text(data.courseName),
    previousGrade: data.previousGrade as number, newGrade: data.newGrade as number, reason: text(data.reason),
    actorId: text(data.actorId), actorName: text(data.actorName), actorEmail: text(data.actorEmail) || null,
    actorRole: text(data.actorRole), correctedAt: gradeAnalysisIsoDate(data.correctedAt),
  };
}

export async function correctGradeScale(
  actor: TeacherAccessContext,
  input: ReturnType<typeof parseGradeCorrection>,
  requestMetadata: { userAgent: string; forwardedFor: string; requestTrace: string },
): Promise<GradeCorrection> {
  const db = getAdminFirestore();
  const enrollmentRef = db.collection(input.source).doc(input.enrollmentId);
  const auditRef = db.collection("gradeScaleCorrections").doc(input.requestId);
  await db.runTransaction(async transaction => {
    const actorDoc = await transaction.get(db.collection("users").doc(actor.uid));
    const actorData = actorDoc.data() || {};
    const actorRole = text(actorData.role) || actor.role;
    const policy = gradeScalePolicy(actorRole, actorData);
    const enrollment = await transaction.get(enrollmentRef);
    if (!enrollment.exists) throw new TeacherAccessError(404, "La inscripción ya no existe. Actualiza el análisis.");
    const data = enrollment.data()!;
    const groupId = text(data.groupId);
    const groupDoc = groupId ? await transaction.get(db.collection("groups").doc(groupId)) : null;
    const group = groupDoc?.data() || {};
    if (!canReviewGradeGroup(policy, actor.uid, group)) throw new TeacherAccessError(403, "No tienes acceso a este alumno y grupo.");
    const existing = await transaction.get(auditRef);
    if (existing.exists) {
      const event = existing.data()!;
      if (event.actorId !== actor.uid || event.source !== input.source || event.enrollmentId !== input.enrollmentId ||
        event.courseId !== input.courseId || event.newGrade !== input.newGrade || event.reason !== input.reason) {
        throw new TeacherAccessError(409, "La solicitud ya se utilizó para otra corrección.");
      }
      return; // A retried request must not create a second correction.
    }
    const revision = enrollment.updateTime ? `${enrollment.updateTime.seconds}:${enrollment.updateTime.nanoseconds}` : "";
    if (revision !== input.revision) throw new TeacherAccessError(409, "La inscripción cambió desde el análisis. Actualiza y revisa la nota antes de corregirla.");
    const finding = analyzeEnrollmentGradeScale(data).find(item => item.courseId === input.courseId);
    if (!finding) throw new TeacherAccessError(409, "Esta nota ya no es un caso pendiente del análisis.");
    if (finding.grade === input.newGrade) throw new TeacherAccessError(400, "La nueva nota debe ser diferente de la actual.");
    const before = enrollmentGradeClosures(data)[input.courseId] as Record<string, unknown>;
    const studentId = text(data.studentId);
    const student = studentId ? (await transaction.get(db.collection("users").doc(studentId))).data() || {} : {};
    const course = (await transaction.get(db.collection("courses").doc(input.courseId))).data() || {};
    const now = FieldValue.serverTimestamp();
    const actorName = text(actorData.displayName) || text(actorData.name) || actor.displayName;
    const after = {
      ...before, finalGrade: input.newGrade, gradeScale: 100, manualOverride: true,
      gradeSource: "gradeScaleCorrection", updatedAt: now, correctedAt: now,
      correctedById: actor.uid, correctedByName: actorName, correctionId: auditRef.id,
      correctionReason: input.reason,
    };
    const event = {
      schemaVersion: 1, action: "correctFinalGradeScale", source: input.source,
      enrollmentId: enrollment.id, enrollmentPath: enrollmentRef.path, enrollmentRevision: revision,
      studentId, studentName: text(data.studentName) || text(student.displayName) || text(student.name) || studentId,
      groupId, groupName: text(data.groupName) || text(group.groupName) || groupId,
      plantelId: text(group.plantelId), courseId: input.courseId,
      courseName: finding.courseName || text(course.title) || input.courseId,
      previousGrade: finding.grade, newGrade: input.newGrade, reason: input.reason,
      previousGradeScale: before.gradeScale ?? null, newGradeScale: 100,
      actorId: actor.uid, actorName, actorEmail: text(actorData.email) || actor.email,
      actorRole, correctedAt: now, requestId: input.requestId, requestMetadata,
      before, after, // Retain the original closure, original grading date and signed-document references.
    };
    const legacyKey = `courseClosures.${input.courseId}`;
    if (Object.prototype.hasOwnProperty.call(data, legacyKey)) {
      transaction.update(enrollmentRef, new FieldPath("courseClosures", input.courseId), after, new FieldPath(legacyKey), FieldValue.delete());
    } else {
      transaction.update(enrollmentRef, new FieldPath("courseClosures", input.courseId), after);
    }
    transaction.create(auditRef, event);
  });
  return serializeGradeCorrection(auditRef.id, (await auditRef.get()).data()!);
}
