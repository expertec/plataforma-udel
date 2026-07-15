import type { User } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";

export type StudentPlatformView = "modern" | "traditional";

export const STUDENT_PLATFORM_VIEW_FIELD = "preferredStudentView";
export const DEFAULT_STUDENT_PLATFORM_VIEW: StudentPlatformView = "modern";

export const normalizeStudentPlatformView = (value: unknown): StudentPlatformView =>
  value === "traditional" ? "traditional" : DEFAULT_STUDENT_PLATFORM_VIEW;

export const getStudentHomeRoute = (preferredView: StudentPlatformView): string =>
  preferredView === "traditional" ? "/aula" : "/feed";

export const getStudentProfileRoute = (preferredView: StudentPlatformView): string =>
  preferredView === "traditional" ? "/aula/perfil" : "/student/profile";

export const getStudentPlatformViewLabel = (preferredView: StudentPlatformView): string =>
  preferredView === "traditional" ? "Vista tradicional (/aula)" : "Vista moderna (/feed)";

export const loadStudentPlatformViewForUser = async (
  user: User,
): Promise<StudentPlatformView> => {
  const snap = await getDoc(doc(db, "users", user.uid));
  return normalizeStudentPlatformView(snap.data()?.[STUDENT_PLATFORM_VIEW_FIELD]);
};

export const saveStudentPlatformViewForUser = async (
  user: User,
  preferredView: StudentPlatformView,
): Promise<StudentPlatformView> => {
  const normalized = normalizeStudentPlatformView(preferredView);
  await setDoc(
    doc(db, "users", user.uid),
    {
      [STUDENT_PLATFORM_VIEW_FIELD]: normalized,
      updatedAt: new Date(),
    },
    { merge: true },
  );
  return normalized;
};
