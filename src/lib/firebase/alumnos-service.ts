import {
  addDoc,
  collection,
  getDocs,
  limit as fbLimit,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";

export type Alumno = {
  id: string;
  nombre: string;
  email: string;
  estado: "activo" | "completado" | "baja";
  creadoEn?: Date;
};

const mockPool = [
  { nombre: "Ana García", email: "ana.demo@mail.com" },
  { nombre: "Juan López", email: "juan.demo@mail.com" },
  { nombre: "María Ruiz", email: "maria.demo@mail.com" },
  { nombre: "Pedro Gómez", email: "pedro.demo@mail.com" },
  { nombre: "Lucía Torres", email: "lucia.demo@mail.com" },
  { nombre: "Carlos Méndez", email: "carlos.demo@mail.com" },
  { nombre: "Sofía Hernández", email: "sofia.demo@mail.com" },
  { nombre: "Miguel Pérez", email: "miguel.demo@mail.com" },
];

export async function createMockAlumnos(count = 5): Promise<Alumno[]> {
  const alumnosRef = collection(db, "alumnos");
  const shuffled = [...mockPool].sort(() => Math.random() - 0.5).slice(0, count);
  const created: Alumno[] = [];

  for (const item of shuffled) {
    const docRef = await addDoc(alumnosRef, {
      nombre: item.nombre,
      email: item.email,
      estado: "activo",
      creadoEn: serverTimestamp(),
    });
    created.push({
      id: docRef.id,
      nombre: item.nombre,
      email: item.email,
      estado: "activo",
      creadoEn: new Date(),
    });
  }

  return created;
}

export async function getAlumnos(limitNumber = 20): Promise<Alumno[]> {
  const alumnosRef = collection(db, "alumnos");
  const q = query(alumnosRef, orderBy("creadoEn", "desc"), fbLimit(limitNumber));
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      nombre: d.nombre ?? "",
      email: d.email ?? "",
      estado: d.estado ?? "activo",
      creadoEn: d.creadoEn?.toDate?.(),
    };
  });
}
