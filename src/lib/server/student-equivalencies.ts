import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import {
  equivalencyFinalGrade,
  equivalencyNameKey,
  validateEquivalencyInput,
  type EquivalencyInput,
  type StudentEquivalency,
} from "@/lib/students/equivalencies";

import { sameAcademicSubject, type StudentAcademicHistory } from "@/lib/students/academic-history";

type RecordData = Record<string, unknown>;
export type EquivalencyAccess = { uid: string; role: string; plantelIds: string[] };

export class EquivalencyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
const plantels = (data: RecordData) => Array.from(new Set([...strings(data.plantelIds), text(data.plantelId)].filter(Boolean)));
export const canManageEquivalencies = (access: EquivalencyAccess) => access.role === "adminTeacher" || access.role === "superAdminTeacher";

export function assertEquivalencyId(id: string): void {
  if (!id || id.length > 200 || id.includes("/") || id === "." || id === "..") throw new EquivalencyError(400, "Identificador inválido.");
}

export async function resolveEquivalencyAccess(authorization: string | null): Promise<EquivalencyAccess> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new EquivalencyError(401, "Inicia sesión para continuar.");
  let decoded;
  try { decoded = await getAdminAuth().verifyIdToken(token); }
  catch { throw new EquivalencyError(401, "La sesión expiró. Inicia sesión nuevamente."); }
  const user = await getAdminFirestore().collection("users").doc(decoded.uid).get();
  const data = user.data() ?? {};
  return { uid: decoded.uid, role: text(data.role ?? decoded.role), plantelIds: plantels(data) };
}

export async function readStudentEquivalencies(studentId: string, access: EquivalencyAccess, history = false): Promise<StudentEquivalency[]> {
  assertEquivalencyId(studentId);
  const admin = canManageEquivalencies(access);
  const self = access.uid === studentId;
  const coordinator = access.role === "coordinadorPlantel" || access.role === "director";
  if (!admin && !self && !coordinator) throw new EquivalencyError(403, "No tienes permisos para consultar equivalencias.");
  if (history && !admin) throw new EquivalencyError(403, "El historial administrativo requiere permisos de administrador.");
  const db = getAdminFirestore();
  if (!admin && !self) {
    const student = await db.collection("users").doc(studentId).get();
    const studentData = student.data() ?? {};
    const studentPlantelIds = [...plantels(studentData), ...strings(studentData.archivedPlantelIds)];
    if (!studentPlantelIds.some((plantelId) => access.plantelIds.includes(plantelId))) {
      throw new EquivalencyError(403, "Alumno fuera del alcance de tu plantel.");
    }
  }
  const snapshot = await db.collection("studentEquivalencies").where("studentId", "==", studentId).get();
  return snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }) as StudentEquivalency)
    .filter((entry) => (history || entry.status === "active") && (admin || self || entry.plantelIds.some((plantelId) => access.plantelIds.includes(plantelId))))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

type Mutation = { action: "create"; entries: EquivalencyInput[] } |
  { action: "update"; id: string; version: number; entry: EquivalencyInput; reason: string } |
  { action: "cancel"; id: string; version: number; reason: string };

export function parseEquivalencyMutation(body: unknown, create: boolean): Mutation {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new EquivalencyError(400, "Solicitud inválida.");
  const input = body as RecordData;
  try {
    if (create) {
      if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 40) throw new Error("Agrega entre 1 y 40 materias por captura.");
      return { action: "create", entries: input.entries.map(validateEquivalencyInput) };
    }
    const id = text(input.id);
    assertEquivalencyId(id);
    if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new Error("La versión del registro no es válida.");
    const reason = text(input.reason);
    if (!reason || reason.length > 1000) throw new Error("Indica el motivo del cambio (máximo 1000 caracteres).");
    if (input.action === "cancel") return { action: "cancel", id, version: input.version as number, reason };
    if (input.action === "update") return { action: "update", id, version: input.version as number, reason, entry: validateEquivalencyInput(input.entry) };
    throw new Error("Acción inválida.");
  } catch (error) {
    throw new EquivalencyError(400, error instanceof Error ? error.message : "Revisa los datos de la equivalencia.");
  }
}

export async function mutateStudentEquivalencies(studentId: string, access: EquivalencyAccess, mutation: Mutation): Promise<void> {
  assertEquivalencyId(studentId);
  if (!canManageEquivalencies(access)) throw new EquivalencyError(403, "Solo los administradores pueden registrar o modificar equivalencias.");
  const db = getAdminFirestore();
  const entries = mutation.action === "create" ? mutation.entries : mutation.action === "update" ? [mutation.entry] : [];
  const references = entries.map(() => db.collection("studentEquivalencies").doc());
  await db.runTransaction(async (transaction) => {
    const lock = db.collection("studentEquivalencyLocks").doc(studentId);
    await transaction.get(lock);
    const student = await transaction.get(db.collection("users").doc(studentId));
    if (!student.exists || student.data()?.role !== "student") throw new EquivalencyError(404, "No se encontró al alumno.");
    const snapshot = await transaction.get(db.collection("studentEquivalencies").where("studentId", "==", studentId));
    const existing = snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }) as StudentEquivalency);
    const previous = mutation.action === "create" ? undefined : existing.find((entry) => entry.id === mutation.id);
    if (mutation.action !== "create") {
      if (!previous) throw new EquivalencyError(404, "No se encontró la equivalencia.");
      if (previous.status !== "active" || previous.version !== mutation.version) throw new EquivalencyError(409, "La equivalencia cambió. Recarga la lista antes de continuar.");
    }
    const courseIds = Array.from(new Set(entries.map((entry) => entry.courseId).filter((courseId): courseId is string => Boolean(courseId))));
    const courseDocs = await Promise.all(courseIds.map((courseId) => transaction.get(db.collection("courses").doc(courseId))));
    const courseTitles = new Map<string, string>();
    courseDocs.forEach((course) => {
      const data = course.data() ?? {};
      const title = text(data.title) || text(data.courseName) || text(data.name);
      if (!course.exists || data.isArchived === true || data.isInduction === true || data.isProbe === true || !title) throw new EquivalencyError(400, "Una materia seleccionada ya no está disponible. Actualiza el catálogo.");
      courseTitles.set(course.id, title);
    });
    const normalizedEntries = entries.map((entry) => ({ ...entry, courseName: entry.courseId ? courseTitles.get(entry.courseId)! : entry.courseName }));
    const active = existing.filter((entry) => entry.status === "active" && entry.id !== previous?.id);
    const identities = active.map((entry) => ({ courseId: entry.courseId, name: equivalencyNameKey(entry.courseName) }));
    normalizedEntries.forEach((entry) => {
      const name = equivalencyNameKey(entry.courseName);
      if (identities.some((identity) => (entry.courseId && identity.courseId === entry.courseId) || identity.name === name)) throw new EquivalencyError(409, `Ya existe una equivalencia vigente para ${entry.courseName}.`);
      identities.push({ courseId: entry.courseId, name });
    });
    if (normalizedEntries.length > 0) {
      const manualHistory = await transaction.get(db.collection("studentAcademicHistory").where("studentId", "==", studentId));
      normalizedEntries.forEach((entry) => {
        if (manualHistory.docs.some((doc) => {
          const record = doc.data() as StudentAcademicHistory;
          return record.status === "active" && record.section === "academic" && sameAcademicSubject(entry, record);
        })) throw new EquivalencyError(409, `${entry.courseName} ya tiene historial académico manual. Revisa el expediente antes de registrar la equivalencia.`);
      });
      const live = await transaction.get(db.collection("studentEnrollments").where("studentId", "==", studentId));
      const archived = await transaction.get(db.collection("studentEnrollmentsArchive").where("studentId", "==", studentId));
      const groupIds = Array.from(new Set(live.docs.map((entry) => text(entry.data().groupId)).filter(Boolean)));
      const groups = await Promise.all(groupIds.map((groupId) => transaction.get(db.collection("groups").doc(groupId))));
      const groupsById = new Map(groups.map((group) => [group.id, group.data() ?? {}]));
      const conflicts: Array<{ courseId: string; name: string }> = [];
      [...live.docs, ...archived.docs].forEach((enrollment) => {
        const data = enrollment.data();
        const closures = data.courseClosures && typeof data.courseClosures === "object" ? data.courseClosures as RecordData : {};
        Object.entries(closures).forEach(([courseId, closure]) => {
          const record = closure && typeof closure === "object" ? closure as RecordData : {};
          conflicts.push({ courseId, name: equivalencyNameKey(text(record.courseName) || text(data.courseName)) });
        });
        if (text(data.courseId) && (typeof data.finalGrade === "number" || Object.keys(closures).length === 0)) conflicts.push({ courseId: text(data.courseId), name: equivalencyNameKey(text(data.courseName)) });
      });
      live.docs.forEach((enrollment) => {
        const data = enrollment.data();
        if (["archived", "inactive", "baja"].includes(text(data.status))) return;
        const group = groupsById.get(text(data.groupId)) ?? {};
        const courses = Array.isArray(group.courses) ? group.courses : [{ courseId: group.courseId, courseName: group.courseName }];
        const override = data.isCourseOverride === true || data.scope === "course" || ["courseOverride", "extraCourse"].includes(text(data.source));
        const assigned = [...strings(data.courseIds), text(data.courseId)];
        courses.forEach((course: RecordData) => {
          const courseId = text(course.courseId);
          if (!courseId || strings(data.excludedCourseIds).includes(courseId) || (override && !assigned.includes(courseId))) return;
          conflicts.push({ courseId, name: equivalencyNameKey(text(course.courseName)) });
        });
      });
      normalizedEntries.forEach((entry) => {
        if (conflicts.some((conflict) => (entry.courseId && entry.courseId === conflict.courseId) || equivalencyNameKey(entry.courseName) === conflict.name)) throw new EquivalencyError(409, `${entry.courseName} ya está inscrita o tiene historial de calificaciones. Revisa su carga e historial antes de registrar la equivalencia.`);
      });
    }
    const now = new Date().toISOString();
    if (mutation.action === "cancel" && previous) {
      const updated = { ...previous, status: "cancelled" as const, updatedAt: now, updatedBy: access.uid, version: previous.version + 1, changeReason: mutation.reason };
      transaction.set(db.collection("studentEquivalencies").doc(previous.id), updated);
      transaction.create(db.collection("studentEquivalencies").doc(previous.id).collection("history").doc(), { before: previous, after: updated, action: "cancel", actorId: access.uid, at: now, reason: mutation.reason });
    } else {
      normalizedEntries.forEach((entry, index) => {
        const reference = previous ? db.collection("studentEquivalencies").doc(previous.id) : references[index];
        const updated: StudentEquivalency = {
          ...entry, id: reference.id, studentId, finalGrade: equivalencyFinalGrade(entry), status: "active",
          plantelIds: previous?.plantelIds ?? plantels(student.data() ?? {}),
          createdAt: previous?.createdAt ?? now, createdBy: previous?.createdBy ?? access.uid,
          updatedAt: now, updatedBy: access.uid, version: (previous?.version ?? 0) + 1,
          changeReason: mutation.action === "update" ? mutation.reason : "Registro de equivalencia",
        };
        transaction.set(reference, updated);
        transaction.create(reference.collection("history").doc(), { before: previous ?? null, after: updated, action: mutation.action, actorId: access.uid, at: now, reason: updated.changeReason });
      });
    }
    transaction.set(lock, { updatedAt: FieldValue.serverTimestamp() });
  });
}
