import { doc, getDoc, setDoc } from "firebase/firestore";
import { updateProfile, type User } from "firebase/auth";
import { db } from "@/lib/firebase/firestore";
import { getStudentSubmissions, type Submission } from "@/lib/firebase/submissions-service";
import {
  normalizeStudentPlatformView,
  type StudentPlatformView,
} from "@/lib/student-platform-view";
import { trimSafeString } from "./gating";

export type StudentProfile = {
  displayName: string;
  email: string;
  phone: string;
  program: string;
  plantelNames: string[];
  photoURL: string;
  preferredStudentView: StudentPlatformView;
};

export const loadStudentProfile = async (user: User): Promise<StudentProfile> => {
  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? snap.data() : {};

  const plantelNames = Array.isArray(data.plantelNames)
    ? data.plantelNames.map((name: unknown) => trimSafeString(name)).filter(Boolean)
    : [];

  return {
    displayName: trimSafeString(data.displayName ?? data.name) || user.displayName || "Estudiante",
    email: trimSafeString(data.email) || user.email || "",
    phone: trimSafeString(data.phone),
    program: trimSafeString(data.program ?? data.degree),
    plantelNames,
    photoURL: trimSafeString(data.photoURL) || user.photoURL || "",
    preferredStudentView: normalizeStudentPlatformView(data.preferredStudentView),
  };
};

/**
 * Las reglas de Firestore solo dejan al alumno cambiar displayName, name,
 * photoURL, updatedAt, mustChangePassword y preferredStudentView sobre su propio documento
 * (`canSelfUpsertProfile`). El resto de los campos los administra el plantel.
 */
export const updateStudentDisplayName = async (user: User, displayName: string) => {
  const name = displayName.trim();
  if (!name) throw new Error("El nombre no puede quedar vacío");

  await setDoc(
    doc(db, "users", user.uid),
    { displayName: name, name, updatedAt: new Date() },
    { merge: true },
  );
  await updateProfile(user, { displayName: name });
  return name;
};

/** Las entregas viven por grupo, así que se consultan todos los grupos a la vez. */
export const loadAllSubmissions = async (
  groupIds: string[],
  studentId: string,
): Promise<Submission[]> => {
  const perGroup = await Promise.all(
    groupIds.map((groupId) =>
      getStudentSubmissions(groupId, studentId).catch((err) => {
        console.warn(`No se pudieron leer las entregas del grupo ${groupId}:`, err);
        return [] as Submission[];
      }),
    ),
  );

  return perGroup
    .flat()
    .sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0));
};

export const isGraded = (submission: Submission) =>
  submission.status === "graded" || typeof submission.grade === "number";

export const formatDate = (date?: Date | null) => {
  if (!date) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
};
