import { User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firestore";

export type UserRole = "teacher" | "student";

export async function resolveUserRole(user: User): Promise<UserRole | null> {
  try {
    const tokenResult = await user.getIdTokenResult();
    const claimRole = tokenResult.claims?.role;
    if (claimRole === "teacher" || claimRole === "student") {
      return claimRole;
    }
  } catch {
    // fall through to Firestore lookup
  }

  try {
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    const data = snap.data();
    const role = data?.role;
    if (role === "teacher" || role === "student") {
      return role;
    }
  } catch {
    // ignore and return null
  }

  return null;
}
