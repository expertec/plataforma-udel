import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
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
};

export async function getStudentUsers(maxResults?: number): Promise<StudentUser[]> {
  const usersRef = collection(db, "users");
  const constraints: QueryConstraint[] = [
    where("role", "==", "student"),
    orderBy("createdAt", "desc"),
  ];
  if (typeof maxResults === "number" && maxResults > 0) {
    constraints.push(limit(maxResults));
  }
  const snap = await getDocs(query(usersRef, ...constraints));
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.displayName ?? d.name ?? "Alumno",
      email: d.email ?? "",
      estado: d.estado ?? d.status,
      phone: d.phone ?? null,
    };
  });
}

export async function createStudentAccount(params: {
  name: string;
  email: string;
  password: string;
  createdBy?: string | null;
  phone?: string;
}): Promise<string> {
  const trimmedName = params.name.trim() || "Alumno";
  const { uid } = await createAccountWithRole({
    email: params.email,
    password: params.password,
    displayName: trimmedName,
    role: "student",
    createdBy: params.createdBy,
    phone: params.phone,
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
    return { uid: existingDoc.id, alreadyExisted: true };
  }

  const uid = await createStudentAccount({
    name: trimmedName,
    email: normalizedEmail,
    password: params.password,
    createdBy: params.createdBy,
    phone: params.phone,
  });
  return { uid, alreadyExisted: false };
}

export async function ensureStudentAccount(params: {
  name: string;
  email: string;
  password: string;
  createdBy?: string | null;
  phone?: string;
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
    await updateDoc(doc(db, "users", existingDoc.id), {
      displayName: trimmedName,
      name: trimmedName,
      role: "student",
      phone: params.phone ?? null,
      status: "active",
      provider: "password",
      updatedAt: serverTimestamp(),
      updatedBy: params.createdBy ?? null,
    });

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
