"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  addStudentsToGroup,
  getGroup,
  getGroupStudents,
  Group,
  GroupStudent,
  removeStudentFromGroup,
} from "@/lib/firebase/groups-service";
import { getStudentUsers, StudentUser } from "@/lib/firebase/students-service";
import toast from "react-hot-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { EntregasTab } from "./_components/EntregasTab";

export default function GroupDetailPage() {
  const params = useParams<{ groupId: string }>();
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [studentsModalOpen, setStudentsModalOpen] = useState(false);
  const [groupStudents, setGroupStudents] = useState<GroupStudent[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!params?.groupId) return;
      setLoading(true);
      try {
        const g = await getGroup(params.groupId);
        setGroup(g);
        if (g) {
          setLoadingStudents(true);
          getGroupStudents(params.groupId)
            .then(setGroupStudents)
            .catch(() => toast.error("No se pudieron cargar los alumnos del grupo"))
            .finally(() => setLoadingStudents(false));
        }
      } catch (err) {
        console.error(err);
        toast.error("No se pudo cargar el grupo");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [params?.groupId]);

  const headerInfo = useMemo(() => {
    if (!group) return "";
    const range = group.startDate && group.endDate
      ? ` • ${formatRange(group.startDate, group.endDate)}`
      : "";
    return `${group.studentsCount}/${group.maxStudents} estudiantes${range}`;
  }, [group]);

  const handleRemoveStudent = async (student: GroupStudent) => {
    if (!group) return;
    const confirmed = window.confirm(`¿Eliminar a ${student.studentName} del grupo?`);
    if (!confirmed) return;
    setRemovingId(student.id);
    try {
      await removeStudentFromGroup(group.id, student.id);
      setGroupStudents((prev) => prev.filter((s) => s.id !== student.id));
      setGroup((prev) =>
        prev ? { ...prev, studentsCount: Math.max(prev.studentsCount - 1, 0) } : prev,
      );
      toast.success("Alumno eliminado del grupo");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar al alumno");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between">
        <Link href="/creator/grupos" className="text-sm text-blue-600 hover:underline">
          ← Volver a grupos
        </Link>
        <span className="text-xs text-slate-500">ID: {params?.groupId}</span>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Cargando grupo...
        </div>
      ) : !group ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-700 shadow-sm">
          No se encontró el grupo.
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Grupo</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold text-slate-900">{group.groupName}</h1>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                {group.semester}
              </span>
              <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                {group.status === "active" ? "Activo" : group.status === "finished" ? "Finalizado" : "Archivado"}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Curso: <span className="font-medium">{group.courseName}</span>
            </p>
            <p className="text-sm text-slate-600">{headerInfo}</p>
          </div>

          <Tabs defaultValue="estudiantes" className="w-full space-y-4">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="estudiantes">Estudiantes</TabsTrigger>
              <TabsTrigger value="entregas">Entregas</TabsTrigger>
              <TabsTrigger value="calificaciones">Calificaciones</TabsTrigger>
              <TabsTrigger value="config">Configuración</TabsTrigger>
            </TabsList>

            <TabsContent value="estudiantes">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <AlumnosTab
                  groupId={group.id}
                  studentsCount={group.studentsCount}
                  maxStudents={group.maxStudents}
                  students={groupStudents}
                  loadingStudents={loadingStudents}
                  removingId={removingId}
                  onStudentsAdded={(count) =>
                    setGroup((prev) =>
                      prev ? { ...prev, studentsCount: prev.studentsCount + count } : prev,
                    )
                  }
                  onOpenModal={() => setStudentsModalOpen(true)}
                  onRemoveStudent={handleRemoveStudent}
                />
              </div>
            </TabsContent>

            <TabsContent value="entregas">
              <EntregasTab
                groupId={group.id}
                courseId={group.courseId}
                studentsCount={group.studentsCount}
              />
            </TabsContent>

            <TabsContent value="calificaciones">
              <div className="rounded-lg bg-white p-6 shadow-sm">
                <p className="text-gray-500">Próximamente</p>
              </div>
            </TabsContent>

            <TabsContent value="config">
              <div className="rounded-lg bg-white p-6 shadow-sm">
                <p className="text-gray-500">Próximamente</p>
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}

      {group ? (
        <SelectStudentsModal
          open={studentsModalOpen}
          onClose={() => setStudentsModalOpen(false)}
          groupId={group.id}
          onReload={async () => {
            setLoadingStudents(true);
            try {
              const data = await getGroupStudents(group.id);
            setGroupStudents(data);
          } finally {
            setLoadingStudents(false);
          }
          }}
          existingIds={groupStudents.map((s) => s.id)}
          onAdded={(count) =>
            setGroup((prev) => (prev ? { ...prev, studentsCount: prev.studentsCount + count } : prev))
          }
        />
      ) : null}
    </div>
  );
}

type AlumnosTabProps = {
  groupId: string;
  studentsCount: number;
  maxStudents: number;
  students: GroupStudent[];
  loadingStudents: boolean;
  removingId: string | null;
  onStudentsAdded: (count: number) => void;
  onOpenModal: () => void;
  onRemoveStudent: (student: GroupStudent) => void;
};

function AlumnosTab({
  onOpenModal,
  studentsCount,
  maxStudents,
  students,
  loadingStudents,
  removingId,
  onRemoveStudent,
}: AlumnosTabProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onOpenModal}
          disabled={studentsCount >= maxStudents}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {studentsCount >= maxStudents ? "Cupo lleno" : "+ Agregar Estudiantes"}
        </button>
        <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Importar CSV
        </button>
        <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Exportar
        </button>
      </div>
      {loadingStudents ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
          Cargando alumnos...
        </div>
      ) : students.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
          Aún no hay alumnos en este grupo.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-4 gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
            <span>Nombre</span>
            <span>Email</span>
            <span>Inscrito</span>
            <span className="text-right">Acciones</span>
          </div>
          <div className="divide-y divide-slate-200">
            {students.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-4 items-center gap-3 px-4 py-2 text-sm text-slate-800"
              >
                <span>{s.studentName}</span>
                <span className="text-slate-600">{s.studentEmail}</span>
                <span className="text-slate-600">
                  {s.enrolledAt ? s.enrolledAt.toLocaleDateString("es-MX") : "N/D"}
                </span>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => onRemoveStudent(s)}
                    disabled={removingId === s.id}
                    className="text-sm text-red-600 hover:underline disabled:opacity-60"
                  >
                    {removingId === s.id ? "Eliminando..." : "Eliminar"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatRange(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
  return `${start.toLocaleDateString("es-MX", opts)} - ${end.toLocaleDateString("es-MX", opts)}`;
}

type SelectStudentsModalProps = {
  open: boolean;
  onClose: () => void;
  groupId: string;
  onAdded: (count: number) => void;
  onReload: () => Promise<void>;
  existingIds: string[];
};

function SelectStudentsModal({
  open,
  onClose,
  groupId,
  onAdded,
  onReload,
  existingIds,
}: SelectStudentsModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [students, setStudents] = useState<StudentUser[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getStudentUsers(100)
      .then((res) => setStudents(res))
      .catch((err) => {
        console.error(err);
        toast.error("No se pudieron cargar los alumnos (users)");
      })
      .finally(() => setLoading(false));
  }, [open]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = students.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.email.toLowerCase().includes(search.toLowerCase()),
  );

  const handleSave = async () => {
    if (selected.size === 0) {
      toast.error("Selecciona al menos un alumno");
      return;
    }
    setSaving(true);
    try {
      const toAdd = students.filter((s) => selected.has(s.id) && !existingIds.includes(s.id));
      if (toAdd.length === 0) {
        toast.error("Los alumnos seleccionados ya están en el grupo");
        setSaving(false);
        return;
      }
      await addStudentsToGroup({
        groupId,
        students: toAdd.map((s) => ({ id: s.id, nombre: s.name, email: s.email })),
      });
      toast.success("Alumnos agregados al grupo");
      onAdded(toAdd.length);
      await onReload();
      onClose();
      setSelected(new Set());
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron agregar los alumnos");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Alumnos</p>
            <h2 className="text-lg font-semibold text-slate-900">Seleccionar alumnos</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o email"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-600">
              Seleccionados: <span className="font-semibold">{selected.size}</span>
            </p>
          </div>

          {loading ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Cargando alumnos...
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No hay alumnos para mostrar. Crea algunos en la colección &quot;alumnos&quot;.
            </div>
          ) : (
            <div className="max-h-[50vh] overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Sel.</th>
                    <th className="px-3 py-2 text-left">Nombre</th>
                    <th className="px-3 py-2 text-left">Email</th>
                    <th className="px-3 py-2 text-left">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(s.id)}
                          onChange={() => toggle(s.id)}
                          disabled={existingIds.includes(s.id)}
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-900">{s.name}</td>
                      <td className="px-3 py-2 text-slate-600">{s.email}</td>
                      <td className="px-3 py-2 text-slate-600 capitalize">{s.estado ?? "activo"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={saving || selected.size === 0}
              onClick={handleSave}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Agregando..." : "Agregar seleccionados"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
