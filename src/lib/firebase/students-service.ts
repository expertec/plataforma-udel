import { collection, getDocs, query, where, orderBy, limit as fbLimit } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";

export type StudentUser = {
  id: string;
  name: string;
  email: string;
  estado?: string;
};

export async function getStudentUsers(max = 100): Promise<StudentUser[]> {
  const usersRef = collection(db, "users");
  const q = query(usersRef, where("role", "==", "student"), orderBy("createdAt", "desc"), fbLimit(max));
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.displayName ?? d.name ?? "Alumno",
      email: d.email ?? "",
      estado: d.estado ?? d.status,
    };
  });
}
