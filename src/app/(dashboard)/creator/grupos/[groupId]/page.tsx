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
  setAssistantTeachers,
} from "@/lib/firebase/groups-service";
import { getStudentUsers, StudentUser } from "@/lib/firebase/students-service";
import { getTeacherUsers, TeacherUser } from "@/lib/firebase/teachers-service";
import toast from "react-hot-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { EntregasTab } from "./_components/EntregasTab";
import { StudentSubmissionsModal } from "./_components/StudentSubmissionsModal";
import { Course } from "@/lib/firebase/courses-service";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { resolveUserRole, UserRole } from "@/lib/firebase/roles";

export default function GroupDetailPage() {
  const params = useParams<{ groupId: string }>();
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [studentsModalOpen, setStudentsModalOpen] = useState(false);
  const [groupStudents, setGroupStudents] = useState<GroupStudent[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [assignTeachersOpen, setAssignTeachersOpen] = useState(false);
  const [teacherOptions, setTeacherOptions] = useState<TeacherUser[]>([]);
  const [teacherSearch, setTeacherSearch] = useState("");
  const [selectedTeachers, setSelectedTeachers] = useState<Set<string>>(new Set());
  const [savingTeachers, setSavingTeachers] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [removingAssistantId, setRemovingAssistantId] = useState<string | null>(null);
  const [unlinkingCourseId, setUnlinkingCourseId] = useState<string | null>(null);
  const [studentSubmissionsModal, setStudentSubmissionsModal] = useState<{
    open: boolean;
    studentId: string;
    studentName: string;
  }>({ open: false, studentId: "", studentName: "" });

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

  useEffect(() => {
    if (!assignTeachersOpen) return;
    const loadTeachers = async () => {
      try {
        const teachers = await getTeacherUsers(200);
        setTeacherOptions(teachers);
        if (group?.assistantTeacherIds && group.assistantTeacherIds.length > 0) {
          setSelectedTeachers(new Set(group.assistantTeacherIds));
        } else {
          setSelectedTeachers(new Set());
        }
      } catch (err) {
        console.error(err);
        toast.error("No se pudieron cargar los mentores");
      }
    };
    loadTeachers();
  }, [assignTeachersOpen, group?.assistantTeacherIds]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setCurrentUser(u);
      if (!u) {
        setUserRole(null);
        return;
      }
      try {
        const role = await resolveUserRole(u);
        setUserRole(role);
      } catch {
        setUserRole(null);
      }
    });
    return () => unsub();
  }, []);

  const headerInfo = useMemo(() => {
    if (!group) return "";
    const range = group.startDate && group.endDate
      ? ` • ${formatRange(group.startDate, group.endDate)}`
      : "";
    return `${group.studentsCount}/${group.maxStudents} estudiantes${range}`;
  }, [group]);

  const assignedCourses = group?.courses?.filter((c) => c.courseId) ?? [];
  const assignedCourseIds = assignedCourses.map((c) => c.courseId).filter(Boolean);
  const explicitCourseIds = (group?.courseIds ?? []).filter(Boolean);
  const courseIdsForGroup =
    explicitCourseIds.length > 0
      ? explicitCourseIds
      : assignedCourseIds.length > 0
        ? assignedCourseIds
        : group?.courseId
          ? [group.courseId]
          : [];

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

  const toggleTeacher = (id: string) => {
    setSelectedTeachers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveTeachers = async () => {
    if (!group) return;
    setSavingTeachers(true);
    try {
      const selected = teacherOptions.filter((t) => selectedTeachers.has(t.id));
      await setAssistantTeachers(group.id, selected.map((t) => ({ id: t.id, name: t.name, email: t.email })));
      setGroup((prev) =>
        prev
          ? {
              ...prev,
              assistantTeacherIds: selected.map((t) => t.id),
              assistantTeachers: selected.map((t) => ({ id: t.id, name: t.name, email: t.email })),
            }
          : prev,
      );
      toast.success("Mentores asignados al grupo");
      setAssignTeachersOpen(false);
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron asignar los mentores");
    } finally {
      setSavingTeachers(false);
    }
  };

  const handleRemoveAssistant = async (teacherId: string, teacherName: string) => {
    if (!group) return;
      const confirmed = window.confirm(`¿Deseas quitar a ${teacherName} como mentor?`);
    if (!confirmed) return;
    setRemovingAssistantId(teacherId);
    try {
      const remaining = (group.assistantTeachers ?? []).filter((t) => t.id !== teacherId);
      await setAssistantTeachers(
        group.id,
        remaining.map((t) => ({ id: t.id, name: t.name, email: t.email })),
      );
      setGroup((prev) =>
        prev
          ? {
              ...prev,
              assistantTeacherIds: remaining.map((t) => t.id),
              assistantTeachers: remaining,
            }
          : prev,
      );
      toast.success(`${teacherName} fue desvinculado del grupo`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo quitar al mentor");
    } finally {
      setRemovingAssistantId(null);
    }
  };

  const handleUnlinkCourse = async (courseId: string, courseName: string) => {
    if (!group || !params?.groupId) return;

    const coursesCount = assignedCourses.length;
    if (coursesCount <= 1) {
      toast.error("No puedes desvincular el único curso del grupo");
      return;
    }

    if (!window.confirm(`¿Desvincular el curso "${courseName}" de este grupo?\n\nLos alumnos ya no verán las clases de este curso.`)) return;

    setUnlinkingCourseId(courseId);
    try {
      const response = await fetch("/api/groups/unlink-course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: params.groupId,
          courseId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Error al desvincular curso");
      }

      toast.success("Curso desvinculado correctamente");
      const updated = await getGroup(params.groupId);
      if (updated) setGroup(updated);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "No se pudo desvincular el curso");
    } finally {
      setUnlinkingCourseId(null);
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
                {group.status === "active"
                  ? "Activo"
                  : group.status === "finished"
                  ? "Finalizado"
                  : "Archivado"}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {group.courseName
                ? (
                  <>
                    Curso base: <span className="font-medium">{group.courseName}</span>
                  </>
                )
                : "Este grupo aún no tiene cursos asignados."}
            </p>
            <p className="text-sm text-slate-600 mt-1">
              Programa:{" "}
              <span className="font-medium">
                {group.program || "Sin programa definido"}
              </span>
            </p>
            {assignedCourses.length > 0 ? (
              <div className="mt-2 text-sm text-slate-600">
                <p className="font-semibold text-slate-800">Materias asignadas</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {assignedCourses.map((c) => (
                    <li key={c.courseId}>{c.courseName}</li>
                  ))}
                </ul>
              </div>
            ) : null}
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
                  onOpenStudentSubmissions={(student) =>
                    setStudentSubmissionsModal({
                      open: true,
                      studentId: student.id,
                      studentName: student.studentName,
                    })
                  }
                />
              </div>
            </TabsContent>

            <TabsContent value="entregas">
              <EntregasTab
                groupId={group.id}
                courseIds={courseIdsForGroup}
                studentsCount={group.studentsCount}
              />
            </TabsContent>

            <TabsContent value="calificaciones">
              <div className="rounded-lg bg-white p-6 shadow-sm">
                <p className="text-gray-500">Próximamente</p>
              </div>
            </TabsContent>

            <TabsContent value="config">
              <div className="rounded-lg bg-white p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Mentores</p>
                    <h3 className="text-lg font-semibold text-slate-900">Asignar mentores al grupo</h3>
                    <p className="text-sm text-slate-600">
                      El profesor principal es {group.teacherName || "—"}. Puedes añadir mentores.
                    </p>
                  </div>
                  {userRole === "adminTeacher" ? (
                    <button
                      type="button"
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
                      onClick={() => setAssignTeachersOpen(true)}
                    >
                      Asignar mentores
                    </button>
                  ) : null}
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-800">Profesor principal</p>
                  <p className="text-sm text-slate-700">{group.teacherName || "Sin asignar"}</p>
                  <p className="mt-3 text-sm font-semibold text-slate-800">Mentores</p>
                  {group.assistantTeachers && group.assistantTeachers.length > 0 ? (
                    <ul className="mt-2 space-y-2 text-sm text-slate-700">
                      {group.assistantTeachers.map((t) => (
                        <li key={t.id} className="flex items-center justify-between gap-3">
                          <div>
                            <p>{t.name}</p>
                            <p className="text-xs text-slate-500">{t.email}</p>
                          </div>
                          {currentUser?.uid === group.teacherId ? (
                            <button
                              type="button"
                              onClick={() => handleRemoveAssistant(t.id, t.name)}
                              disabled={removingAssistantId === t.id}
                              className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:border-red-400 disabled:border-red-100 disabled:text-red-300"
                            >
                              {removingAssistantId === t.id ? "Desvinculando..." : "Desvincular"}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-slate-600">No hay mentores asignados.</p>
                  )}
                </div>

                {/* Sección de Cursos */}
                <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-6">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Cursos</p>
                    <h3 className="text-lg font-semibold text-slate-900">Cursos vinculados al grupo</h3>
                    <p className="text-sm text-slate-600">
                      Gestiona los cursos que los alumnos pueden ver en este grupo.
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-800">Cursos asignados</p>
                  {assignedCourses.length > 0 ? (
                    <ul className="mt-2 space-y-2 text-sm text-slate-700">
                      {assignedCourses.map((course) => (
                        <li key={course.courseId} className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">{course.courseName}</p>
                            <p className="text-xs text-slate-500">ID: {course.courseId}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleUnlinkCourse(course.courseId, course.courseName)}
                            disabled={unlinkingCourseId === course.courseId || assignedCourses.length === 1}
                            className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:border-red-400 disabled:cursor-not-allowed disabled:border-red-100 disabled:text-red-300"
                            title={assignedCourses.length === 1 ? "No puedes desvincular el único curso" : "Desvincular curso del grupo"}
                          >
                            {unlinkingCourseId === course.courseId ? "Desvinculando..." : "Desvincular"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-slate-600">No hay cursos asignados a este grupo.</p>
                  )}
                </div>
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

      {studentSubmissionsModal.open && group ? (
        <StudentSubmissionsModal
          groupId={group.id}
          studentId={studentSubmissionsModal.studentId}
          studentName={studentSubmissionsModal.studentName}
          isOpen={studentSubmissionsModal.open}
          onClose={() => setStudentSubmissionsModal({ open: false, studentId: "", studentName: "" })}
        />
      ) : null}

      {assignTeachersOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Mentores
                </p>
                <h4 className="text-lg font-semibold text-slate-900">Asignar mentores</h4>
                <p className="text-sm text-slate-600">
                  Selecciona los mentores que tendrán acceso a este grupo.
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setAssignTeachersOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <input
                type="text"
                placeholder="Buscar por nombre o email"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                value={teacherSearch}
                onChange={(e) => setTeacherSearch(e.target.value)}
              />
              {(() => {
                const term = teacherSearch.toLowerCase();
                const filtered = teacherOptions.filter(
                  (t) => t.name.toLowerCase().includes(term) || t.email.toLowerCase().includes(term),
                );
                return (
                  <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                    {filtered.length === 0 ? (
                    <p className="p-3 text-sm text-slate-600">No hay mentores registrados.</p>
                    ) : (
                      <ul className="divide-y divide-slate-200">
                        {filtered.map((t) => (
                          <li
                            key={t.id}
                            className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm transition hover:bg-slate-50 ${
                              selectedTeachers.has(t.id) ? "bg-blue-50" : ""
                            }`}
                            onClick={() => toggleTeacher(t.id)}
                          >
                            <div>
                              <p className="font-semibold text-slate-800">{t.name}</p>
                              <p className="text-xs text-slate-500">{t.email}</p>
                            </div>
                            {selectedTeachers.has(t.id) ? (
                              <span className="text-xs font-semibold text-blue-600">Seleccionado</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })()}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveTeachers}
                  disabled={savingTeachers}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {savingTeachers ? "Guardando..." : "Guardar asignación"}
                </button>
                <p className="text-xs text-slate-500">
                  Los mentores seleccionados tendrán acceso a alumnos y entregas de este grupo.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type AlumnosTabProps = {
  groupId: string;
  studentsCount: number;
  students: GroupStudent[];
  loadingStudents: boolean;
  removingId: string | null;
  onStudentsAdded: (count: number) => void;
  onOpenModal: () => void;
  onRemoveStudent: (student: GroupStudent) => void;
  onOpenStudentSubmissions: (student: GroupStudent) => void;
};

function AlumnosTab({
  onOpenModal,
  studentsCount,
  students,
  loadingStudents,
  removingId,
  onRemoveStudent,
  onOpenStudentSubmissions,
}: AlumnosTabProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onOpenModal}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
        >
          + Agregar Estudiantes
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
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenStudentSubmissions(s)}
                    className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 text-sm font-medium text-blue-600 hover:border-blue-400 hover:bg-blue-100"
                  >
                    Tareas
                  </button>
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
    getStudentUsers()
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
