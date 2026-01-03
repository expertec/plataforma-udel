"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { Submission, getAllSubmissions } from "@/lib/firebase/submissions-service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type CalificacionesTabProps = {
  groupId: string;
  courseId: string;
};

type Student = { id: string; name: string };
type Task = { id: string; title: string; type: "assignment" | "quiz"; column: string };

export function CalificacionesTab({ groupId, courseId }: CalificacionesTabProps) {
  const [students, setStudents] = useState<Student[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
        const students = studentsSnap.docs.map((d) => ({
          id: d.id,
          name: d.data().studentName ?? "",
        }));

        const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));
        const tasksAcc: Task[] = [];
        let aCount = 0;
        let qCount = 0;
        for (const lesson of lessonsSnap.docs) {
          const classesSnap = await getDocs(
            query(
              collection(db, "courses", courseId, "lessons", lesson.id, "classes"),
              orderBy("order", "asc"),
            ),
          );
          classesSnap.forEach((cls) => {
            const data = cls.data();
            if (data.type === "assignment" || data.type === "quiz") {
              if (data.type === "assignment") aCount += 1;
              else qCount += 1;
              tasksAcc.push({
                id: cls.id,
                title: data.title ?? "Sin título",
                type: data.type,
                column: data.type === "assignment" ? `T${aCount}` : `Q${qCount}`,
              });
            }
          });
        }

        const submissions = await getAllSubmissions(groupId);

        setStudents(students);
        setTasks(tasksAcc);
        setSubmissions(submissions);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [courseId, groupId]);

  const gradeMatrix = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    submissions.forEach((s) => {
      if (!map[s.studentId]) map[s.studentId] = {};
      if (typeof s.grade === "number") map[s.studentId][s.classId] = s.grade;
    });
    return map;
  }, [submissions]);

  const finals = useMemo(() => {
    const res: Record<string, number | null> = {};
    students.forEach((st) => {
      const grades = tasks
        .map((t) => gradeMatrix[st.id]?.[t.id])
        .filter((g) => typeof g === "number") as number[];
      res[st.id] = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null;
    });
    return res;
  }, [students, tasks, gradeMatrix]);

  const exportCsv = () => {
    const headers = ["Alumno", ...tasks.map((t) => t.column), "FINAL"];
    const lines = students.map((st) => {
      const grades = tasks.map((t) => gradeMatrix[st.id]?.[t.id] ?? "-");
      const final = finals[st.id] != null ? finals[st.id]!.toFixed(2) : "-";
      return [st.name, ...grades, final].join(",");
    });
    const csv = [headers.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `calificaciones_${groupId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const groupRef = doc(db, "groups", groupId);
      const studentsRef = collection(db, "groups", groupId, "students");
      const studentsSnap = await getDocs(studentsRef);
      const batch = writeBatch(db);
      batch.update(groupRef, { status: "finished" });
      studentsSnap.docs.forEach((d) => {
        batch.update(d.ref, { status: "completed" });
        const enrollmentRef = doc(db, "studentEnrollments", `${d.id}-${groupId}`);
        batch.set(
          enrollmentRef,
          {
            studentId: d.id,
            groupId,
            status: "completed",
            updatedAt: new Date(),
          },
          { merge: true },
        );
      });
      await batch.commit();
      setConfirmOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setPublishing(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando calificaciones...
      </div>
    );
  }

  if (!tasks.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        No hay tareas (assignments/quizzes) en este curso.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={exportCsv}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Exportar CSV
        </button>
        <button
          type="button"
          onClick={() => {}}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Calcular Promedios
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
        >
          Publicar Calificaciones
        </button>
      </div>

      <div className="overflow-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Alumno</th>
              {tasks.map((t) => (
                <th key={t.id} className="px-3 py-2 text-left">
                  {t.column}
                </th>
              ))}
              <th className="px-3 py-2 text-left">FINAL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((st) => (
              <tr key={st.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-900">{st.name}</td>
                {tasks.map((t) => (
                  <td key={t.id} className="px-3 py-2 text-slate-700">
                    {gradeMatrix[st.id]?.[t.id] ?? "-"}
                  </td>
                ))}
                <td className="px-3 py-2 text-slate-900 font-semibold">
                  {finals[st.id] != null ? finals[st.id]!.toFixed(2) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publicar calificaciones</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-700">
            Esta acción es irreversible. Los alumnos verán su calificación final y el grupo se marcará
            como finalizado.
          </p>
          <div className="mt-3 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={publishing}
              onClick={handlePublish}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-60"
            >
              {publishing ? "Publicando..." : "Sí, publicar"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
