import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  updateDoc,
  DocumentSnapshot,
  where,
} from "firebase/firestore";
import type { QueryConstraint } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { auth } from "./client";
import { createAccountWithRole, updateUserPassword } from "./user-management";
import { isStudentStatusActive } from "@/lib/students/status";

export type StudentUser = {
  id: string;
  name: string;
  email: string;
  estado?: string;
  phone?: string | null;
  whatsapp?: string | null;
  program?: string;
  plantelIds?: string[];
  plantelNames?: string[];
};

export type PaginatedStudentsResult = {
  students: StudentUser[];
  lastDoc: DocumentSnapshot | null;
  hasMore: boolean;
  totalCount?: number;
};

const DEFAULT_PAGE_SIZE = 50;

function resolveStudentWhatsApp(data: Record<string, unknown>): string | null {
  const candidates = [
    data.whatsapp,
    data.whatsApp,
    data.whatsappPhone,
    data.whatsappNumber,
    data.phone,
    data.telefono,
    data.tel,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Obtiene estudiantes con paginación para reducir lecturas de Firestore
 * @param pageSize - Número de estudiantes por página (default: 50)
 * @param lastDoc - Último documento de la página anterior para paginación
 * @param searchQuery - Búsqueda opcional por nombre o email
 */
export async function getStudentUsersPaginated(
  pageSize: number = DEFAULT_PAGE_SIZE,
  lastDoc?: DocumentSnapshot | null,
  searchQuery?: string,
  plantelId?: string,
): Promise<PaginatedStudentsResult> {
  const usersRef = collection(db, "users");
  const normalizedPlantelId = plantelId?.trim() ?? "";
  const constraints: QueryConstraint[] = normalizedPlantelId
    ? [where("plantelIds", "array-contains", normalizedPlantelId)]
    : [
        where("role", "==", "student"),
        orderBy("createdAt", "desc"),
      ];

  if (lastDoc) {
    constraints.push(startAfter(lastDoc));
  }

  // Pedimos uno más para saber si hay más páginas
  constraints.push(limit(pageSize + 1));

  const snap = await getDocs(query(usersRef, ...constraints));
  const hasMore = snap.docs.length > pageSize;
  const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;

  let students = docs
    .map((docSnap) => {
      const d = docSnap.data();
      return {
        id: docSnap.id,
        name: d.displayName ?? d.name ?? "Alumno",
        email: d.email ?? "",
        estado: d.estado ?? d.status,
        phone: d.phone ?? null,
        whatsapp: resolveStudentWhatsApp(d),
        program: d.program ?? "",
        plantelIds: Array.isArray(d.plantelIds) ? d.plantelIds : [],
        plantelNames: Array.isArray(d.plantelNames) ? d.plantelNames : [],
        role: d.role ?? null,
      };
    })
    .filter((student) => {
      if (student.role !== "student") return false;
      if (!isStudentStatusActive(student.estado)) return false;
      if (!normalizedPlantelId) return true;
      return student.plantelIds.includes(normalizedPlantelId);
    })
    .map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
      estado: student.estado,
      phone: student.phone,
      whatsapp: student.whatsapp,
      program: student.program,
      plantelIds: student.plantelIds,
      plantelNames: student.plantelNames,
    }));

  // Filtrar localmente si hay búsqueda (para búsquedas simples)
  if (searchQuery) {
    const q = searchQuery.toLowerCase().trim();
    students = students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        (s.program ?? "").toLowerCase().includes(q)
    );
  }

  return {
    students,
    lastDoc: docs.length > 0 ? docs[docs.length - 1] : null,
    hasMore,
  };
}

/**
 * Obtiene el conteo total de estudiantes (para mostrar en UI)
 */
export async function getStudentsCount(plantelId?: string): Promise<number> {
  const usersRef = collection(db, "users");
  const normalizedPlantelId = plantelId?.trim() ?? "";
  const q = normalizedPlantelId
    ? query(usersRef, where("plantelIds", "array-contains", normalizedPlantelId))
    : query(usersRef, where("role", "==", "student"));
  const snapshot = await getDocs(q);
  return snapshot.docs.reduce((count, docSnap) => {
    const data = docSnap.data();
    if (data.role !== "student") return count;
    if (!isStudentStatusActive(data.estado ?? data.status)) return count;
    return count + 1;
  }, 0);
}

/**
 * Versión legacy con límite por defecto para evitar cargas masivas
 * @deprecated Usar getStudentUsersPaginated para mejor rendimiento
 */
export async function getStudentUsers(maxResults: number = DEFAULT_PAGE_SIZE): Promise<StudentUser[]> {
  const usersRef = collection(db, "users");
  const constraints: QueryConstraint[] = [
    where("role", "==", "student"),
    orderBy("createdAt", "desc"),
    limit(maxResults), // SIEMPRE aplicar límite por defecto
  ];
  const snap = await getDocs(query(usersRef, ...constraints));
  return snap.docs
    .map((docSnap) => {
      const d = docSnap.data();
      return {
        id: docSnap.id,
        name: d.displayName ?? d.name ?? "Alumno",
        email: d.email ?? "",
        estado: d.estado ?? d.status,
        phone: d.phone ?? null,
        whatsapp: resolveStudentWhatsApp(d),
        program: d.program ?? "",
        plantelIds: Array.isArray(d.plantelIds) ? d.plantelIds : [],
        plantelNames: Array.isArray(d.plantelNames) ? d.plantelNames : [],
        role: d.role ?? null,
      };
    })
    .filter((student) => student.role === "student" && isStudentStatusActive(student.estado))
    .map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
      estado: student.estado,
      phone: student.phone,
      whatsapp: student.whatsapp,
      program: student.program,
      plantelIds: student.plantelIds,
      plantelNames: student.plantelNames,
    }));
}

export async function updateStudentPlantelAssignment(params: {
  studentId: string;
  plantelId?: string | null;
  plantelName?: string | null;
}): Promise<void> {
  const studentId = params.studentId.trim();
  const plantelId = params.plantelId?.trim() ?? "";
  const plantelName = params.plantelName?.trim() ?? "";

  if (!studentId) {
    throw new Error("El alumno es requerido");
  }

  await updateDoc(doc(db, "users", studentId), {
    plantelIds: plantelId ? [plantelId] : [],
    plantelNames: plantelName ? [plantelName] : [],
    updatedAt: serverTimestamp(),
  });
}

export async function createStudentAccount(params: {
  name: string;
  email: string;
  password: string;
  createdBy?: string | null;
  phone?: string;
  program: string;
}): Promise<string> {
  const trimmedName = params.name.trim() || "Alumno";
  const { uid } = await createAccountWithRole({
    email: params.email,
    password: params.password,
    displayName: trimmedName,
    role: "student",
    createdBy: params.createdBy,
    phone: params.phone,
    program: params.program,
  });
  return uid;
}

export async function checkStudentExists(email: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;

  const usersRef = collection(db, "users");
  const existingSnap = await getDocs(
    query(usersRef, where("email", "==", normalizedEmail), limit(1)),
  );
  return !existingSnap.empty;
}

export async function createStudentIfNotExists(params: {
  name: string;
  email: string;
  password: string;
  createdBy?: string | null;
  phone?: string;
  program: string;
}): Promise<{ uid: string; alreadyExisted: boolean }> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const trimmedName = params.name.trim() || "Alumno";
  if (!normalizedEmail) {
    throw new Error("El correo del alumno es requerido");
  }

  const usersRef = collection(db, "users");
  const existingSnap = await getDocs(
    query(usersRef, where("email", "==", normalizedEmail), limit(1)),
  );
  if (!existingSnap.empty) {
    const existingDoc = existingSnap.docs[0];
    await updateDoc(doc(db, "users", existingDoc.id), {
      program: params.program ?? "",
      updatedAt: serverTimestamp(),
      updatedBy: params.createdBy ?? null,
    });
    return { uid: existingDoc.id, alreadyExisted: true };
  }

  const uid = await createStudentAccount({
    name: trimmedName,
    email: normalizedEmail,
    password: params.password,
    createdBy: params.createdBy,
    phone: params.phone,
    program: params.program,
  });
  return { uid, alreadyExisted: false };
}

export async function ensureStudentAccount(params: {
  name: string;
  email: string;
  password: string;
  createdBy?: string | null;
  phone?: string;
  program?: string;
  updatePassword?: boolean;
}): Promise<{ uid: string; alreadyExisted: boolean; passwordUpdated?: boolean }> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const trimmedName = params.name.trim() || "Alumno";
  if (!normalizedEmail) {
    throw new Error("El correo del alumno es requerido");
  }

  const usersRef = collection(db, "users");
  const existingSnap = await getDocs(
    query(usersRef, where("email", "==", normalizedEmail), limit(1)),
  );
  if (!existingSnap.empty) {
    const existingDoc = existingSnap.docs[0];
    const updateData: Record<string, unknown> = {
      displayName: trimmedName,
      name: trimmedName,
      role: "student",
      phone: params.phone ?? null,
      status: "active",
      provider: "password",
      updatedAt: serverTimestamp(),
      updatedBy: params.createdBy ?? null,
    };
    if (params.program !== undefined) {
      updateData.program = params.program ?? "";
    }
    await updateDoc(doc(db, "users", existingDoc.id), updateData);

    // Si se solicita actualizar contraseña, intentamos con la función de user-management
    let passwordUpdated = false;
    if (params.updatePassword && params.password) {
      try {
        // Intentamos actualizar usando Firebase Admin a través de la app de gestión
        const result = await updateUserPassword({
          email: normalizedEmail,
          oldPassword: params.password, // Usamos la misma como "antigua"
          newPassword: params.password,
        });
        passwordUpdated = result.success;
      } catch {
        // Si falla, continuamos sin actualizar contraseña
        passwordUpdated = false;
      }
    }

    return { uid: existingDoc.id, alreadyExisted: true, passwordUpdated };
  }

  const uid = await createStudentAccount({
    name: trimmedName,
    email: normalizedEmail,
    password: params.password,
    createdBy: params.createdBy,
    phone: params.phone,
    program: params.program ?? "",
  });
  return { uid, alreadyExisted: false, passwordUpdated: true };
}

export async function archiveStudent(params: {
  userId: string;
  email?: string;
  reason?: string;
}): Promise<void> {
  const userId = params.userId.trim();
  if (!userId) return;
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("No hay sesión activa para archivar al alumno");
  }

  const token = await currentUser.getIdToken();
  const response = await fetch("/api/students/archive", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      studentId: userId,
      email: params.email?.trim().toLowerCase() || undefined,
      reason: params.reason?.trim() || undefined,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(payload.error || "No se pudo archivar al alumno");
  }
}

export async function deactivateStudent(userId: string, email?: string): Promise<void> {
  return archiveStudent({ userId, email });
}

export async function updateStudentPassword(params: {
  email: string;
  oldPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; message?: string }> {
  return await updateUserPassword(params);
}
