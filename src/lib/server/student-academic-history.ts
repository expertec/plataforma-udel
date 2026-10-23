import { FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  academicHistoryFinalGrade, sameAcademicAttempt, sameAcademicSubject, validateAcademicHistoryInput,
  type AcademicHistoryInput, type StudentAcademicHistory,
} from "@/lib/students/academic-history";
import { equivalencyNameKey, type StudentEquivalency } from "@/lib/students/equivalencies";
import { isCertificationGroup } from "@/lib/students/kardex";
import { academicRecordCapturePlantelIds, assertEquivalencyId, canCreateAcademicRecords, canManageEquivalencies, EquivalencyError, type EquivalencyAccess } from "./student-equivalencies";

type Data = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
const plantels = (data: Data) => Array.from(new Set([...strings(data.plantelIds), text(data.plantelId)].filter(Boolean)));

export async function readStudentAcademicHistory(studentId: string, access: EquivalencyAccess, history = false): Promise<StudentAcademicHistory[]> {
  assertEquivalencyId(studentId);
  const admin = canManageEquivalencies(access);
  const self = access.uid === studentId;
  const coordinator = access.role === "coordinadorPlantel" || access.role === "director";
  if (!admin && !self && !coordinator) throw new EquivalencyError(403, "No tienes permisos para consultar el historial académico.");
  if (history && !admin) throw new EquivalencyError(403, "El historial administrativo requiere permisos de administrador.");
  const db = getAdminFirestore();
  if (!admin && !self) {
    const student = await db.collection("users").doc(studentId).get();
    const data = student.data() ?? {};
    if (![...plantels(data), ...strings(data.archivedPlantelIds)].some((id) => access.plantelIds.includes(id))) throw new EquivalencyError(403, "Alumno fuera del alcance de tu plantel.");
  }
  const snapshot = await db.collection("studentAcademicHistory").where("studentId", "==", studentId).get();
  return snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }) as StudentAcademicHistory)
    .filter((entry) => (history || entry.status === "active") && (admin || self || entry.plantelIds.some((id) => access.plantelIds.includes(id))))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

type Mutation = { action: "create"; entries: AcademicHistoryInput[] } |
  { action: "update"; id: string; version: number; entry: AcademicHistoryInput; reason: string } |
  { action: "cancel"; id: string; version: number; reason: string };

export function parseAcademicHistoryMutation(body: unknown, create: boolean): Mutation {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new EquivalencyError(400, "Solicitud inválida.");
  const input = body as Data;
  try {
    if (create) {
      if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 40) throw new Error("Agrega entre 1 y 40 materias por captura.");
      return { action: "create", entries: input.entries.map(validateAcademicHistoryInput) };
    }
    const id = text(input.id);
    assertEquivalencyId(id);
    if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new Error("La versión del registro no es válida.");
    const reason = text(input.reason);
    if (!reason || reason.length > 1000) throw new Error("Indica el motivo del cambio (máximo 1000 caracteres).");
    if (input.action === "cancel") return { action: "cancel", id, version: input.version as number, reason };
    if (input.action === "update") return { action: "update", id, version: input.version as number, reason, entry: validateAcademicHistoryInput(input.entry) };
    throw new Error("Acción inválida.");
  } catch (error) { throw new EquivalencyError(400, error instanceof Error ? error.message : "Revisa los datos del historial académico."); }
}

export async function mutateStudentAcademicHistory(studentId: string, access: EquivalencyAccess, mutation: Mutation): Promise<void> {
  assertEquivalencyId(studentId);
  const admin = canManageEquivalencies(access);
  if (!(mutation.action === "create" ? canCreateAcademicRecords(access) : admin)) throw new EquivalencyError(403, "No tienes permisos para realizar esta acción en el historial académico.");
  const db = getAdminFirestore();
  const entries = mutation.action === "create" ? mutation.entries : mutation.action === "update" ? [mutation.entry] : [];
  const references = entries.map(() => db.collection("studentAcademicHistory").doc());
  await db.runTransaction(async (transaction) => {
    // Shared with equivalencies so concurrent manual/equivalency captures serialize.
    const lock = db.collection("studentEquivalencyLocks").doc(studentId);
    await transaction.get(lock);
    const student = await transaction.get(db.collection("users").doc(studentId));
    if (!student.exists || student.data()?.role !== "student") throw new EquivalencyError(404, "No se encontró al alumno.");
    const capturePlantelIds = academicRecordCapturePlantelIds(access, student.data() ?? {});
    const snapshot = await transaction.get(db.collection("studentAcademicHistory").where("studentId", "==", studentId));
    const existing = snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }) as StudentAcademicHistory);
    const previous = mutation.action === "create" ? undefined : existing.find((entry) => entry.id === mutation.id);
    if (mutation.action !== "create") {
      if (!previous) throw new EquivalencyError(404, "No se encontró el registro académico.");
      if (previous.status !== "active" || previous.version !== mutation.version) throw new EquivalencyError(409, "El registro cambió. Recarga la lista antes de continuar.");
    }
    const courseIds = Array.from(new Set(entries.flatMap((entry) => entry.courseId ? [entry.courseId] : [])));
    const groupIds = Array.from(new Set(entries.flatMap((entry) => entry.groupId ? [entry.groupId] : [])));
    const courseDocs = await Promise.all(courseIds.map((id) => transaction.get(db.collection("courses").doc(id))));
    const groupDocs = await Promise.all(groupIds.map((id) => transaction.get(db.collection("groups").doc(id))));
    const courseTitles = new Map<string, string>();
    courseDocs.forEach((course) => {
      const data = course.data() ?? {};
      const preserved = previous?.courseId === course.id;
      const title = preserved ? previous.courseName : text(data.title) || text(data.courseName) || text(data.name);
      if ((!course.exists && !preserved) || data.isInduction === true || data.isProbe === true || !title) throw new EquivalencyError(400, "Una materia seleccionada ya no está disponible. Actualiza el catálogo.");
      courseTitles.set(course.id, title);
    });
    const groups = new Map(groupDocs.map((group) => [group.id, group.data()]));
    groupDocs.forEach((group) => {
      const preserved = previous?.groupId === group.id;
      if ((!preserved && (!group.exists || !text(group.data()?.groupName))) || group.data()?.isProbe === true) throw new EquivalencyError(400, "Un grupo seleccionado ya no está disponible. Actualiza la lista.");
      if (!admin && !plantels(group.data() ?? {}).some((id) => capturePlantelIds.includes(id))) throw new EquivalencyError(403, "Un grupo seleccionado está fuera del alcance de tu plantel.");
    });
    const normalized = entries.map((entry) => ({
      ...entry, courseName: entry.courseId ? courseTitles.get(entry.courseId)! : entry.courseName,
      groupName: entry.groupId ? (previous?.groupId === entry.groupId ? previous.groupName : text(groups.get(entry.groupId)?.groupName)) : entry.groupName,
    }));
    const active = existing.filter((entry) => entry.status === "active" && entry.id !== previous?.id);
    const identities: AcademicHistoryInput[] = [...active];
    normalized.forEach((entry) => {
      if (identities.some((identity) => sameAcademicAttempt(entry, identity))) throw new EquivalencyError(409, `${entry.courseName} ya tiene un registro para ese grupo y ciclo.`);
      identities.push(entry);
    });
    if (normalized.length > 0) {
      const equivalents = await transaction.get(db.collection("studentEquivalencies").where("studentId", "==", studentId));
      const live = await transaction.get(db.collection("studentEnrollments").where("studentId", "==", studentId));
      const archived = await transaction.get(db.collection("studentEnrollmentsArchive").where("studentId", "==", studentId));
      const enrollmentGroupIds = Array.from(new Set([...live.docs, ...archived.docs].map((doc) => text(doc.data().groupId)).filter(Boolean)));
      const enrollmentGroups = await Promise.all(enrollmentGroupIds.map((id) => transaction.get(db.collection("groups").doc(id))));
      const groupsById = new Map(enrollmentGroups.map((group) => [group.id, group.data() ?? {}]));
      normalized.forEach((entry) => {
        if (entry.section === "academic" && equivalents.docs.some((doc) => {
          const equivalent = doc.data() as StudentEquivalency;
          return equivalent.status === "active" && sameAcademicSubject(entry, equivalent);
        })) throw new EquivalencyError(409, `${entry.courseName} ya tiene una equivalencia vigente. Revisa el expediente antes de capturarla.`);
        [...live.docs, ...archived.docs].forEach((doc) => {
          const enrollment = doc.data();
          const groupId = text(enrollment.groupId);
          const group = groupsById.get(groupId) ?? {};
          const groupName = text(group.groupName) || text(enrollment.groupName);
          const sameGroup = Boolean(entry.groupId && entry.groupId === groupId) || [groupName, text(enrollment.groupName)].some((name) => name && equivalencyNameKey(name) === equivalencyNameKey(entry.groupName));
          const section = isCertificationGroup(groupName) || isCertificationGroup(enrollment.groupName) ? "certifications" : "academic";
          if (!sameGroup || section !== entry.section) return;
          const cycle = text(enrollment.cycle) || text(group.cycle);
          if (cycle && equivalencyNameKey(cycle) !== equivalencyNameKey(entry.cycle)) return;
          const closures = enrollment.courseClosures && typeof enrollment.courseClosures === "object" ? enrollment.courseClosures as Data : {};
          const subjects = Object.entries(closures).map(([courseId, closure]) => ({ courseId, courseName: text((closure as Data)?.courseName) || text(enrollment.courseName) }));
          if (typeof enrollment.finalGrade === "number") subjects.push({ courseId: text(enrollment.courseId), courseName: text(enrollment.courseName) });
          if (subjects.some((subject) => sameAcademicSubject(entry, subject))) throw new EquivalencyError(409, `${entry.courseName} ya tiene historial en ese grupo. Revisa sus calificaciones antes de capturarla.`);
        });
      });
    }
    const now = new Date().toISOString();
    if (mutation.action === "cancel" && previous) {
      const updated = { ...previous, status: "cancelled" as const, updatedAt: now, updatedBy: access.uid, version: previous.version + 1, changeReason: mutation.reason };
      const reference = db.collection("studentAcademicHistory").doc(previous.id);
      transaction.set(reference, updated);
      transaction.create(reference.collection("history").doc(), { before: previous, after: updated, action: "cancel", actorId: access.uid, at: now, reason: mutation.reason });
    } else {
      normalized.forEach((entry, index) => {
        const reference = previous ? db.collection("studentAcademicHistory").doc(previous.id) : references[index];
        const group = entry.groupId ? groups.get(entry.groupId) : undefined;
        const updated: StudentAcademicHistory = {
          ...entry, id: reference.id, studentId, finalGrade: academicHistoryFinalGrade(entry), status: "active",
          plantelIds: group && plantels(group).length ? plantels(group).filter((id) => admin || capturePlantelIds.includes(id)) : previous?.plantelIds ?? capturePlantelIds,
          createdAt: previous?.createdAt ?? now, createdBy: previous?.createdBy ?? access.uid,
          updatedAt: now, updatedBy: access.uid, version: (previous?.version ?? 0) + 1,
          changeReason: mutation.action === "update" ? mutation.reason : "Registro manual de historial académico",
        };
        transaction.set(reference, updated);
        transaction.create(reference.collection("history").doc(), { before: previous ?? null, after: updated, action: mutation.action, actorId: access.uid, at: now, reason: updated.changeReason });
      });
    }
    transaction.set(lock, { updatedAt: FieldValue.serverTimestamp() });
  });
}
