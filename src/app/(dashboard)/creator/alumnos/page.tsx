"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { getStudentUsers, StudentUser } from "@/lib/firebase/students-service";

export default function AlumnosPage() {
  const [students, setStudents] = useState<StudentUser[]>([]);
  const [loading, setLoading] = useState(true);

  const loadFromDb = async () => {
    setLoading(true);
    try {
      const data = await getStudentUsers(100);
      setStudents(data);
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar los alumnos (users)");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFromDb();
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Alumnos</p>
        <h1 className="text-2xl font-semibold text-slate-900">Panel de alumnos</h1>
        <p className="text-sm text-slate-600">
          Aquí podrás gestionar a tus alumnos, inscribirlos a grupos y revisar su progreso.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={loadFromDb}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          disabled={loading}
        >
          {loading ? "Cargando..." : "Refrescar lista"}
        </button>
        <span className="text-sm text-slate-600">
          Lista de usuarios con rol estudiante (colección &quot;users&quot;).
        </span>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          Cargando alumnos...
        </div>
      ) : students.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          No se encontraron alumnos con rol estudiante.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-4 gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
            <span>Nombre</span>
            <span>Email</span>
            <span>Inscrito</span>
            <span>Estado</span>
          </div>
          <div className="divide-y divide-slate-200">
            {students.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-4 gap-3 px-4 py-2 text-sm text-slate-800"
              >
                <span>{s.name}</span>
                <span className="text-slate-600">{s.email}</span>
                <span className="text-slate-600">N/D</span>
                <span className="text-green-600 font-medium capitalize">Activo</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
