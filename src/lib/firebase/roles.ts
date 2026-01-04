import { User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firestore";

export type UserRole = "teacher" | "student" | "adminTeacher";

const allowedRoles: UserRole[] = ["teacher", "student", "adminTeacher"];

export async function resolveUserRole(user: User): Promise<UserRole | null> {
  try {
    const tokenResult = await user.getIdTokenResult();
    const claimRole = tokenResult.claims?.role;
    if (allowedRoles.includes(claimRole as UserRole)) {
      return claimRole as UserRole;
    }
  } catch {
    // fall through to Firestore lookup
  }

  try {
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    const data = snap.data();
    const role = data?.role as UserRole | undefined;
    if (role && allowedRoles.includes(role)) {
      return role;
    }
  } catch {
    // ignore and return null
  }

  return null;
}
