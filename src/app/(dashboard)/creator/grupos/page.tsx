"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { onAuthStateChanged, User } from "firebase/auth";
import { getCourses } from "@/lib/firebase/courses-service";
import { CreateGroupModal } from "./_components/CreateGroupModal";
import { BulkCreateGroupsModal } from "./_components/BulkCreateGroupsModal";
import {
  getGroupsForTeacher,
  Group,
  deleteGroup,
  getGroupsWhereAssistant,
  getAllGroups,
} from "@/lib/firebase/groups-service";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import {
  isAdminTeacherRole,
  isCampusCoordinatorRole,
  resolveUserRole,
  UserRole,
} from "@/lib/firebase/roles";

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [assistantGroups, setAssistantGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(!auth.currentUser);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (u) => {
      setCurrentUser(u);
      setAuthLoading(false);
      if (u) {
        try {
          const role = await resolveUserRole(u);
          if (!cancelled) setUserRole(role);
        } catch {
          if (!cancelled) setUserRole(null);
        }
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const loadGroupsData = useCallback(async () => {
    if (!currentUser?.uid) {
      setGroups([]);
      setAssistantGroups([]);
      setCourses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      if (isCampusCoordinatorRole(userRole)) {
        const coordinatorGroups = await getAllGroups();
        setGroups(coordinatorGroups);
        setAssistantGroups([]);
        setCourses([]);
        return;
      }

      const [myGroups, myAssistantGroups, myCourses] = await Promise.all([
        isAdminTeacherRole(userRole) ? getGroupsForTeacher(currentUser.uid) : Promise.resolve([]),
        getGroupsWhereAssistant(currentUser.uid),
        getCourses(),
      ]);
      setGroups(myGroups);
      setAssistantGroups(myAssistantGroups);
      setCourses(myCourses.map((c) => ({ id: c.id, title: c.title })));
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar los grupos");
    } finally {
      setLoading(false);
    }
  }, [currentUser?.uid, userRole]);

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

  const searchTerm = search.trim().toLowerCase();
  const hasSearch = searchTerm.length > 0;

  const { activeGroups, finishedGroups, activeAssistantGroups, finishedAssistantGroups } = useMemo(() => {
    const matchesSearch = (group: Group) => {
      if (!searchTerm) return true;
      const searchableText = [
        group.groupName,
        group.courseName,
        group.program,
        group.teacherName,
        group.semester,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(searchTerm);
    };

    const active = groups.filter((g) => g.status !== "finished" && matchesSearch(g));
    const finished = groups.filter((g) => g.status === "finished" && matchesSearch(g));
    const activeAssistant = assistantGroups.filter((g) => g.status !== "finished" && matchesSearch(g));
    const finishedAssistant = assistantGroups.filter((g) => g.status === "finished" && matchesSearch(g));
    return {
      activeGroups: active,
      finishedGroups: finished,
      activeAssistantGroups: activeAssistant,
      finishedAssistantGroups: finishedAssistant,
    };
  }, [groups, assistantGroups, searchTerm]);

  const formatRange = (start?: Date | null, end?: Date | null) => {
    if (!start || !end) return "Sin fechas";
    const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
    return `${start.toLocaleDateString("es-MX", opts)} - ${end.toLocaleDateString("es-MX", opts)}`;
  };

  const handleCreated = (group: Group) => {
    setGroups((prev) => [group, ...prev]);
  };

  const totalGroups = groups.length + assistantGroups.length;
  const filteredTotalGroups =
    activeGroups.length + finishedGroups.length + activeAssistantGroups.length + finishedAssistantGroups.length;
  const isAdminTeacher = isAdminTeacherRole(userRole);
  const isCampusCoordinator = isCampusCoordinatorRole(userRole);

  return (
    <RoleGate allowedRole={["teacher", "adminTeacher", "superAdminTeacher", "coordinadorPlantel"]}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
              Grupos
            </p>
            <h1 className="text-2xl font-semibold text-slate-900">
              {isCampusCoordinator ? "Todos los grupos" : isAdminTeacher ? "Mis grupos" : "Grupos asignados"}
            </h1>
          </div>
          {isAdminTeacher ? (
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
          ) : null}
        </div>

        {loading ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Cargando grupos...
          </div>
        ) : totalGroups === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
            {isCampusCoordinator
              ? "No hay grupos registrados todavía."
              : isAdminTeacher
              ? "Aún no tienes grupos. Crea el primero para asignar alumnos."
              : "Aún no te han asignado como mentor de ningún grupo."}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex-1">
                <span className="sr-only">Buscar grupos</span>
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar por grupo, curso, programa o profesor"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </label>
              {hasSearch ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Limpiar
                </button>
              ) : null}
            </div>

            {filteredTotalGroups === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
                No encontramos grupos que coincidan con tu búsqueda.
              </div>
            ) : null}

            {/* Grupos creados por el AdminTeacher */}
            {filteredTotalGroups > 0 && isAdminTeacher && activeGroups.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">Mis Grupos Activos</h2>
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
            ) : null}

            {filteredTotalGroups > 0 && isCampusCoordinator && activeGroups.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">Grupos Activos</h2>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {activeGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Grupos donde es mentor */}
            {filteredTotalGroups > 0 && !isCampusCoordinator && activeAssistantGroups.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    {isAdminTeacher ? "Grupos como Mentor - Activos" : "Grupos Activos"}
                  </h2>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {activeAssistantGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                      isMentor
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Grupos finalizados propios */}
            {filteredTotalGroups > 0 && isAdminTeacher && finishedGroups.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-800">
                  Mis Grupos Finalizados
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

            {filteredTotalGroups > 0 && isCampusCoordinator && finishedGroups.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-800">
                  Grupos Finalizados
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {finishedGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Grupos finalizados como mentor */}
            {filteredTotalGroups > 0 && !isCampusCoordinator && finishedAssistantGroups.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-800">
                  {isAdminTeacher ? "Grupos como Mentor - Finalizados" : "Grupos Finalizados"}
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {finishedAssistantGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                      isMentor
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
  isMentor,
}: {
  group: Group;
  formatRange: (s?: Date | null, e?: Date | null) => string;
  onDelete?: (groupId: string) => void;
  deleting?: boolean;
  isMentor?: boolean;
}) {
  const statusColor =
    group.status === "active" ? "text-green-600" : group.status === "finished" ? "text-slate-600" : "text-amber-600";
  const statusLabel =
    group.status === "active" ? "Activo" : group.status === "finished" ? "Finalizado" : "Archivado";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-slate-900">{group.groupName}</p>
            {isMentor ? (
              <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                Mentor
              </span>
            ) : null}
          </div>
          <p className="text-sm text-slate-600">{group.courseName || "Grupo"}</p>
          {group.program ? (
            <span className="mt-1 inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              {group.program}
            </span>
          ) : null}
          {isMentor ? (
            <p className="mt-1 text-xs text-slate-500">
              Profesor: {group.teacherName}
            </p>
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
