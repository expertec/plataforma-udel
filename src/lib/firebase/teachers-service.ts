import { collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc, where, limit as fbLimit } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { createAccountWithRole } from "./user-management";

export type TeacherUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  phone?: string | null;
};

export async function getTeacherUsers(max = 100): Promise<TeacherUser[]> {
  const usersRef = collection(db, "users");
  const q = query(
    usersRef,
    where("role", "in", ["teacher", "adminTeacher", "superAdminTeacher"]),
    orderBy("createdAt", "desc"),
    fbLimit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.displayName ?? d.name ?? "Profesor",
      email: d.email ?? "",
      role: d.role ?? "teacher",
      phone: d.phone ?? null,
    };
  });
}

export async function createTeacherAccount(params: {
  name: string;
  email: string;
  password: string;
  role?: "teacher" | "adminTeacher" | "superAdminTeacher";
  asAdminTeacher?: boolean;
  phone?: string;
  createdBy?: string | null;
}): Promise<string> {
  const trimmedName = params.name.trim() || "Profesor";
  const role = params.asAdminTeacher ? "adminTeacher" : params.role ?? "teacher";
  const { uid } = await createAccountWithRole({
    email: params.email,
    password: params.password,
    displayName: trimmedName,
    role,
    createdBy: params.createdBy,
    phone: params.phone,
  });
    return uid;
}

export async function deactivateTeacher(userId: string): Promise<void> {
  if (!userId) return;
  await updateDoc(doc(db, "users", userId), {
    status: "deleted",
    updatedAt: serverTimestamp(),
  });
}
