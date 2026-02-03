import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  getCountFromServer,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  updateDoc,
  where,
  writeBatch,
  DocumentSnapshot,
} from "firebase/firestore";
import type { QueryConstraint } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { createAccountWithRole, updateUserPassword } from "./user-management";

export type StudentUser = {
  id: string;
  name: string;
  email: string;
  estado?: string;
  phone?: string | null;
  program?: string;
};

export type PaginatedStudentsResult = {
  students: StudentUser[];
  lastDoc: DocumentSnapshot | null;
  hasMore: boolean;
  totalCount?: number;
};

const DEFAULT_PAGE_SIZE = 50;

/**
 * Obtiene estudiantes con paginación para reducir lecturas de Firestore
 * @param pageSize - Número de estudiantes por página (default: 50)
 * @param lastDoc - Último documento de la página anterior para paginación
 * @param searchQuery - Búsqueda opcional por nombre o email
 */
export async function getStudentUsersPaginated(
  pageSize: number = DEFAULT_PAGE_SIZE,
  lastDoc?: DocumentSnapshot | null,
  searchQuery?: string
): Promise<PaginatedStudentsResult> {
  const usersRef = collection(db, "users");
  const constraints: QueryConstraint[] = [
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

  let students = docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.displayName ?? d.name ?? "Alumno",
      email: d.email ?? "",
      estado: d.estado ?? d.status,
      phone: d.phone ?? null,
      program: d.program ?? "",
    };
  });

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
export async function getStudentsCount(): Promise<number> {
  const usersRef = collection(db, "users");
  const q = query(usersRef, where("role", "==", "student"));
  const snapshot = await getCountFromServer(q);
  return snapshot.data().count;
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
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.displayName ?? d.name ?? "Alumno",
      email: d.email ?? "",
      estado: d.estado ?? d.status,
      phone: d.phone ?? null,
      program: d.program ?? "",
    };
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

export async function deactivateStudent(userId: string): Promise<void> {
  if (!userId) return;
  const batch = writeBatch(db);
  batch.update(doc(db, "users", userId), {
    status: "deleted",
    updatedAt: serverTimestamp(),
  });
  const enrollmentsSnap = await getDocs(
    query(collection(db, "studentEnrollments"), where("studentId", "==", userId)),
  );
  enrollmentsSnap.docs.forEach((enrollment) => batch.delete(enrollment.ref));

  const studentEnrollmentsGroup = await getDocs(
    query(collectionGroup(db, "students"), where("studentId", "==", userId)),
  );
  studentEnrollmentsGroup.docs.forEach((docSnap) => batch.delete(doc(db, "studentEnrollments", `${docSnap.ref.parent.parent?.id}_${userId}`)));

  await batch.commit();
}

export async function updateStudentPassword(params: {
  email: string;
  oldPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; message?: string }> {
  return await updateUserPassword(params);
}
