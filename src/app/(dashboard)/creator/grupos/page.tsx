"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { onAuthStateChanged, User } from "firebase/auth";
import { getCourses } from "@/lib/firebase/courses-service";
import { CreateGroupModal } from "./_components/CreateGroupModal";
import { BulkCreateGroupsModal } from "./_components/BulkCreateGroupsModal";
import { getGroups, Group, deleteGroup } from "@/lib/firebase/groups-service";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(!auth.currentUser);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setCurrentUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const loadGroupsData = useCallback(async () => {
    if (!currentUser?.uid) {
      setGroups([]);
      setCourses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [myGroups, myCourses] = await Promise.all([
        getGroups(currentUser.uid),
        getCourses(),
      ]);
      setGroups(myGroups);
      setCourses(myCourses.map((c) => ({ id: c.id, title: c.title })));
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar los grupos");
    } finally {
      setLoading(false);
    }
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!authLoading) {
      loadGroupsData();
    }
  }, [authLoading, loadGroupsData]);

  const handleDeleteGroup = async (groupId: string) => {
    if (!groupId) return;
    if (!window.confirm("¿Eliminar este grupo? Esta acción no se puede deshacer.")) return;
    setDeletingGroupId(groupId);
    try {
      await deleteGroup(groupId);
      setGroups((prev) => prev.filter((group) => group.id !== groupId));
      toast.success("Grupo eliminado");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar el grupo");
    } finally {
      setDeletingGroupId(null);
    }
  };

  const { activeGroups, finishedGroups } = useMemo(() => {
    const active = groups.filter((g) => g.status !== "finished");
    const finished = groups.filter((g) => g.status === "finished");
    return { activeGroups: active, finishedGroups: finished };
  }, [groups]);

  const formatRange = (start?: Date | null, end?: Date | null) => {
    if (!start || !end) return "Sin fechas";
    const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
    return `${start.toLocaleDateString("es-MX", opts)} - ${end.toLocaleDateString("es-MX", opts)}`;
  };

  const handleCreated = (group: Group) => {
    setGroups((prev) => [group, ...prev]);
  };

  return (
    <RoleGate allowedRole={["adminTeacher"]}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
              Grupos
            </p>
            <h1 className="text-2xl font-semibold text-slate-900">
              Mis grupos
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
            >
              + Crear Grupo
            </button>
            <button
              type="button"
              onClick={() => setBulkModalOpen(true)}
              className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-700 shadow-sm hover:border-blue-400 hover:text-blue-800"
            >
              Importar desde Excel
            </button>
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Cargando grupos...
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
            Aún no tienes grupos. Crea el primero para asignar alumnos.
          </div>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Activos</h2>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {activeGroups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    formatRange={formatRange}
                    onDelete={handleDeleteGroup}
                    deleting={deletingGroupId === group.id}
                  />
                ))}
              </div>
            </section>

            {finishedGroups.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-800">
                  Finalizados
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {finishedGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                      onDelete={handleDeleteGroup}
                      deleting={deletingGroupId === group.id}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}

        <CreateGroupModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          courses={courses}
          teacherId={currentUser?.uid ?? ""}
          teacherName={currentUser?.displayName ?? "Profesor"}
          onCreated={handleCreated}
        />
        <BulkCreateGroupsModal
          open={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          courses={courses}
          teacherId={currentUser?.uid ?? ""}
          teacherName={currentUser?.displayName ?? "Profesor"}
          onImported={() => {
            loadGroupsData();
          }}
        />
      </div>
    </RoleGate>
  );
}

function GroupCard({
  group,
  formatRange,
  onDelete,
  deleting,
}: {
  group: Group;
  formatRange: (s?: Date | null, e?: Date | null) => string;
  onDelete?: (groupId: string) => void;
  deleting?: boolean;
}) {
  const statusColor =
    group.status === "active" ? "text-green-600" : group.status === "finished" ? "text-slate-600" : "text-amber-600";
  const statusLabel =
    group.status === "active" ? "Activo" : group.status === "finished" ? "Finalizado" : "Archivado";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-slate-900">{group.groupName}</p>
          <p className="text-sm text-slate-600">{group.courseName || "Grupo"}</p>
          {group.program ? (
            <span className="mt-1 inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              {group.program}
            </span>
          ) : null}
        </div>
        <span className={`text-xs font-semibold ${statusColor}`}>{statusLabel}</span>
      </div>
      <div className="mt-3 space-y-1 text-sm text-slate-600">
        <p>
          {group.studentsCount}/{group.maxStudents} estudiantes
        </p>
        <p>{formatRange(group.startDate, group.endDate)}</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link
          href={`/creator/grupos/${group.id}`}
          className="inline-flex items-center rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-blue-600 hover:border-blue-400"
        >
          Gestionar grupo
        </Link>
        {onDelete ? (
          <button
            type="button"
            onClick={() => onDelete(group.id)}
            disabled={deleting}
            className="inline-flex items-center rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition hover:border-red-400 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-300"
          >
            {deleting ? "Eliminando..." : "Eliminar"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
