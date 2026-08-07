"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { onAuthStateChanged, User } from "firebase/auth";
import { getCourses } from "@/lib/firebase/courses-service";
import { CreateGroupModal } from "./_components/CreateGroupModal";
import { BulkCreateGroupsModal } from "./_components/BulkCreateGroupsModal";
import {
  getAllGroups,
  Group,
  deleteGroup,
  getCoordinatorScopeGroups,
  getGroups,
  getGroupsWhereAssistant,
} from "@/lib/firebase/groups-service";
import { getPlanteles, getUserPlantelAssignments, Plantel, PlantelAssignment } from "@/lib/firebase/planteles-service";
import { getTeacherUsers, TeacherUser } from "@/lib/firebase/teachers-service";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import {
  isAdminTeacherRole,
  isCampusCoordinatorRole,
  resolveUserRole,
  UserRole,
} from "@/lib/firebase/roles";
import { normalizeTeacherProfessionalProfile } from "@/lib/teachers/profile";

type GroupViewMode = "cards" | "table";

type GroupCourseClosureSummary = {
  courseId: string;
  courseName: string;
  closedCount: number;
  totalCount: number;
  lastClosedAt: string | null;
  lastClosedByName: string | null;
};

type GroupClosureSummary = {
  loading: boolean;
  error: string | null;
  courses: GroupCourseClosureSummary[];
};

const EMPTY_GROUP_CLOSURE_SUMMARY: GroupClosureSummary = {
  loading: false,
  error: null,
  courses: [],
};

function getGroupCourseList(group: Group): Array<{ courseId: string; courseName: string }> {
  if (Array.isArray(group.courses) && group.courses.length > 0) {
    return group.courses.map((course) => ({
      courseId: course.courseId,
      courseName: course.courseName || "Materia",
    }));
  }
  if (group.courseId) {
    return [{ courseId: group.courseId, courseName: group.courseName || "Materia" }];
  }
  return [];
}

function formatGroupCourses(group: Group): string {
  const courses = getGroupCourseList(group);
  if (courses.length === 0) return "Sin materias";
  return courses.map((course) => course.courseName).join(", ");
}

function formatShortDate(value: string | null): string {
  if (!value) return "Sin cierre";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  } catch {
    // ignore and use fallback
  }
  return "No se pudo cargar el resumen";
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [assistantGroups, setAssistantGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [planteles, setPlanteles] = useState<Plantel[]>([]);
  const [plantelAssignments, setPlantelAssignments] = useState<PlantelAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(!auth.currentUser);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [search, setSearch] = useState("");
  const [plantelFilter, setPlantelFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState<"all" | "presencial" | "enLinea">("all");
  const [viewMode, setViewMode] = useState<GroupViewMode>("cards");
  const [closureSummaries, setClosureSummaries] = useState<Record<string, GroupClosureSummary>>({});
  const [teacherOptions, setTeacherOptions] = useState<TeacherUser[]>([]);
  const [loadingTeacherOptions, setLoadingTeacherOptions] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (u) => {
      setCurrentUser(u);
      setAuthLoading(false);
      if (u) {
        try {
          const role = await resolveUserRole(u);
          if (!cancelled) setUserRole(role);
          if (isCampusCoordinatorRole(role)) {
            const assignments = await getUserPlantelAssignments(u.uid);
            if (!cancelled) setPlantelAssignments(assignments);
          } else if (!cancelled) {
            setPlantelAssignments([]);
          }
        } catch {
          if (!cancelled) setUserRole(null);
          if (!cancelled) setPlantelAssignments([]);
        }
      } else if (!cancelled) {
        setUserRole(null);
        setPlantelAssignments([]);
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
      const isAdminTeacher = isAdminTeacherRole(userRole);
      const isCoordinator = isCampusCoordinatorRole(userRole);
      const coordinatorPlantelIds = plantelAssignments.map((assignment) => assignment.plantelId);
      const ownGroupsPromise = isAdminTeacher
        ? getAllGroups()
        : isCoordinator
          ? getCoordinatorScopeGroups(coordinatorPlantelIds, currentUser.uid)
          : getGroups(currentUser.uid);
      const assistantGroupsPromise =
        isAdminTeacher || isCoordinator ? Promise.resolve([]) : getGroupsWhereAssistant(currentUser.uid);

      const [myGroupsResult, myAssistantGroupsResult, myCoursesResult, campusOptionsResult] = await Promise.allSettled(
        [
          ownGroupsPromise,
          assistantGroupsPromise,
          getCourses(),
          isAdminTeacher ? getPlanteles() : Promise.resolve([]),
        ],
      );

      if (myGroupsResult.status === "fulfilled") {
        setGroups(myGroupsResult.value);
      } else {
        console.error(myGroupsResult.reason);
        setGroups([]);
      }

      if (myAssistantGroupsResult.status === "fulfilled") {
        setAssistantGroups(myAssistantGroupsResult.value);
      } else {
        console.error(myAssistantGroupsResult.reason);
        setAssistantGroups([]);
      }

      if (myCoursesResult.status === "fulfilled") {
        setCourses(myCoursesResult.value.map((c) => ({ id: c.id, title: c.title })));
      } else {
        console.error(myCoursesResult.reason);
        setCourses([]);
        toast.error("No se pudieron cargar los cursos para asignación.");
      }

      if (campusOptionsResult.status === "fulfilled") {
        setPlanteles(campusOptionsResult.value);
      } else {
        console.error(campusOptionsResult.reason);
        setPlanteles([]);
      }

      if (myGroupsResult.status === "rejected" && myAssistantGroupsResult.status === "rejected") {
        toast.error("No se pudieron cargar los grupos");
      } else if (myGroupsResult.status === "rejected") {
        toast.error("No se pudieron cargar tus grupos principales.");
      } else if (myAssistantGroupsResult.status === "rejected") {
        toast.error("No se pudieron cargar tus grupos de mentor.");
      }
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar tus datos de grupos.");
    } finally {
      setLoading(false);
    }
  }, [currentUser?.uid, plantelAssignments, userRole]);

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
        formatGroupCourses(group),
        group.program,
        group.plantelName,
        group.teacherName,
        group.semester,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(searchTerm);
    };

    const matchesPlantel = (group: Group) => {
      if (plantelFilter === "all") return true;
      if (plantelFilter === "unassigned") return !group.plantelId;
      return group.plantelId === plantelFilter;
    };

    const matchesMode = (group: Group) => {
      if (modeFilter === "all") return true;
      if (modeFilter === "presencial") return group.isInPerson === true;
      return group.isInPerson !== true;
    };

    const active = groups.filter(
      (g) => g.status !== "finished" && matchesSearch(g) && matchesPlantel(g) && matchesMode(g),
    );
    const finished = groups.filter(
      (g) => g.status === "finished" && matchesSearch(g) && matchesPlantel(g) && matchesMode(g),
    );
    const activeAssistant = assistantGroups.filter(
      (g) => g.status !== "finished" && matchesSearch(g) && matchesMode(g),
    );
    const finishedAssistant = assistantGroups.filter(
      (g) => g.status === "finished" && matchesSearch(g) && matchesMode(g),
    );
    return {
      activeGroups: active,
      finishedGroups: finished,
      activeAssistantGroups: activeAssistant,
      finishedAssistantGroups: finishedAssistant,
    };
  }, [assistantGroups, groups, modeFilter, plantelFilter, searchTerm]);

  const quickViewGroups = useMemo(
    () => [
      ...activeGroups.map((group) => ({ group, relation: "Principal" as const })),
      ...activeAssistantGroups.map((group) => ({ group, relation: "Mentor" as const })),
      ...finishedGroups.map((group) => ({ group, relation: "Principal" as const })),
      ...finishedAssistantGroups.map((group) => ({ group, relation: "Mentor" as const })),
    ],
    [activeAssistantGroups, activeGroups, finishedAssistantGroups, finishedGroups],
  );

  useEffect(() => {
    if (viewMode !== "table" || quickViewGroups.length === 0 || !currentUser) return;
    const missingGroups = quickViewGroups
      .map((item) => item.group)
      .filter((group) => !closureSummaries[group.id]);
    if (missingGroups.length === 0) return;

    let cancelled = false;
    setClosureSummaries((prev) => {
      const next = { ...prev };
      missingGroups.forEach((group) => {
        next[group.id] = { loading: true, error: null, courses: [] };
      });
      return next;
    });

    const loadSummaries = async () => {
      try {
        const token = await currentUser.getIdToken();
        const response = await fetch("/api/groups/quick-summary", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ groupIds: missingGroups.map((group) => group.id) }),
        });
        if (!response.ok) throw new Error(await readApiError(response));

        const payload = (await response.json()) as {
          data?: {
            summaries?: Array<{
              groupId: string;
              courses: GroupCourseClosureSummary[];
            }>;
          };
        };
        const summaries = payload.data?.summaries ?? [];
        if (cancelled) return;
        setClosureSummaries((prev) => {
          const next = { ...prev };
          const loadedGroupIds = new Set<string>();
          summaries.forEach((summary) => {
            loadedGroupIds.add(summary.groupId);
            next[summary.groupId] = {
              loading: false,
              error: null,
              courses: summary.courses,
            };
          });
          missingGroups.forEach((group) => {
            if (!loadedGroupIds.has(group.id)) {
              next[group.id] = {
                loading: false,
                error: "No se encontro el grupo",
                courses: [],
              };
            }
          });
          return next;
        });
      } catch (err) {
        console.error(err);
        if (cancelled) return;
        setClosureSummaries((prev) => {
          const next = { ...prev };
          missingGroups.forEach((group) => {
            next[group.id] = {
              loading: false,
              error: "No se pudo cargar cierre",
              courses: [],
            };
          });
          return next;
        });
      }
    };

    void loadSummaries();

    return () => {
      cancelled = true;
    };
  }, [closureSummaries, currentUser, quickViewGroups, viewMode]);

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
  const isTeacher = userRole === "teacher";
  const primaryPlantelAssignment = plantelAssignments[0] ?? null;
  const coordinatorHasPlantel = !isCampusCoordinator || plantelAssignments.length > 0;
  const canCreateGroups = isAdminTeacher || (isCampusCoordinator && coordinatorHasPlantel);
  const canViewPrimaryGroups = isAdminTeacher || isCampusCoordinator || isTeacher;
  const hasGlobalGroupsView = isAdminTeacher;
  const canDeleteGroup = (group: Group) =>
    isAdminTeacher || (isCampusCoordinator && group.teacherId === currentUser?.uid);
  const availablePlanteles = useMemo<Plantel[]>(() => {
    if (isAdminTeacher) return planteles;
    return plantelAssignments.map((assignment) => ({
      id: assignment.plantelId,
      name: assignment.plantelName,
      normalizedName: "",
      status: "active",
    }));
  }, [isAdminTeacher, plantelAssignments, planteles]);
  const teacherSelectOptions = useMemo<TeacherUser[]>(() => {
    if (isAdminTeacher) return teacherOptions;
    if (!currentUser?.uid) return [];
    return [
      {
        id: currentUser.uid,
        name: currentUser.displayName ?? "Profesor",
        email: currentUser.email ?? "",
        role: "teacher",
        teacherProfile: normalizeTeacherProfessionalProfile(null),
      },
    ];
  }, [currentUser?.displayName, currentUser?.email, currentUser?.uid, isAdminTeacher, teacherOptions]);

  useEffect(() => {
    if (!isAdminTeacher) {
      setTeacherOptions([]);
      setLoadingTeacherOptions(false);
      return;
    }
    let cancelled = false;
    const loadTeachers = async () => {
      setLoadingTeacherOptions(true);
      try {
        const teachers = await getTeacherUsers(300);
        if (cancelled) return;
        setTeacherOptions(
          [...teachers].sort((a, b) => a.name.localeCompare(b.name, "es")),
        );
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setTeacherOptions([]);
          toast.error("No se pudo cargar el catálogo de profesores.");
        }
      } finally {
        if (!cancelled) setLoadingTeacherOptions(false);
      }
    };
    void loadTeachers();
    return () => {
      cancelled = true;
    };
  }, [isAdminTeacher]);

  return (
    <RoleGate allowedRole={["teacher", "adminTeacher", "superAdminTeacher", "coordinadorPlantel", "director"]}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
              Grupos
            </p>
            <h1 className="text-2xl font-semibold text-slate-900">
              {hasGlobalGroupsView
                ? "Todos los grupos"
                : isCampusCoordinator
                  ? plantelAssignments.length === 1
                    ? `Grupos de ${plantelAssignments[0]?.plantelName || "tu plantel"} + en línea asignados`
                    : "Grupos de tus planteles + en línea asignados"
                  : "Mis grupos asignados"}
            </h1>
          </div>
          {canCreateGroups ? (
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
            {isCampusCoordinator && plantelAssignments.length === 0
              ? "Tu cuenta de coordinador no tiene planteles asignados. Solo verás grupos en línea que te asignen."
              : canCreateGroups
                ? "Aún no hay grupos registrados."
                : "Aún no te han asignado grupos ni mentorías."}
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
              {isAdminTeacher ? (
                <select
                  value={plantelFilter}
                  onChange={(event) => setPlantelFilter(event.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                >
                  <option value="all">Todos los planteles</option>
                  <option value="unassigned">Sin plantel</option>
                  {planteles.map((plantel) => (
                    <option key={plantel.id} value={plantel.id}>
                      {plantel.name}
                    </option>
                  ))}
                  </select>
              ) : null}
              <select
                value={modeFilter}
                onChange={(event) =>
                  setModeFilter(event.target.value as "all" | "presencial" | "enLinea")
                }
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              >
                <option value="all">Todas las modalidades</option>
                <option value="presencial">Presencial</option>
                <option value="enLinea">En línea</option>
              </select>
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

            <div className="creator-tabs-list inline-flex rounded-full p-1">
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  viewMode === "cards"
                    ? "creator-tabs-trigger"
                    : "text-[#754848] hover:bg-white/70"
                }`}
                data-state={viewMode === "cards" ? "active" : "inactive"}
              >
                Tarjetas
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  viewMode === "table"
                    ? "creator-tabs-trigger"
                    : "text-[#754848] hover:bg-white/70"
                }`}
                data-state={viewMode === "table" ? "active" : "inactive"}
              >
                Tabla rápida
              </button>
            </div>

            {filteredTotalGroups === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
                No encontramos grupos que coincidan con tu búsqueda.
              </div>
            ) : null}

            {filteredTotalGroups > 0 && viewMode === "table" ? (
              <QuickGroupsTable
                rows={quickViewGroups}
                closureSummaries={closureSummaries}
                formatRange={formatRange}
              />
            ) : null}

            {/* Grupos propios */}
            {filteredTotalGroups > 0 && viewMode === "cards" && canViewPrimaryGroups && activeGroups.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    {hasGlobalGroupsView ? "Grupos Activos" : "Mis Grupos Activos"}
                  </h2>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {activeGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                      onDelete={canDeleteGroup(group) ? handleDeleteGroup : undefined}
                      deleting={deletingGroupId === group.id}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Grupos donde es mentor */}
            {filteredTotalGroups > 0 && viewMode === "cards" && activeAssistantGroups.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    {canViewPrimaryGroups ? "Grupos como Mentor - Activos" : "Grupos Activos"}
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
            {filteredTotalGroups > 0 && viewMode === "cards" && canViewPrimaryGroups && finishedGroups.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-800">
                  {hasGlobalGroupsView ? "Grupos Finalizados" : "Mis Grupos Finalizados"}
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {finishedGroups.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      formatRange={formatRange}
                      onDelete={canDeleteGroup(group) ? handleDeleteGroup : undefined}
                      deleting={deletingGroupId === group.id}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Grupos finalizados como mentor */}
            {filteredTotalGroups > 0 && viewMode === "cards" && finishedAssistantGroups.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-800">
                  {canViewPrimaryGroups ? "Grupos como Mentor - Finalizados" : "Grupos Finalizados"}
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
          planteles={availablePlanteles}
          defaultPlantelId={primaryPlantelAssignment?.plantelId ?? ""}
          lockPlantel={isCampusCoordinator && availablePlanteles.length <= 1}
          allowCreatePlantel={isAdminTeacher}
          teacherOptions={teacherSelectOptions}
          defaultTeacherId={isAdminTeacher ? "" : currentUser?.uid ?? ""}
          lockTeacher={!isAdminTeacher}
          loadingTeacherOptions={loadingTeacherOptions}
          onCreated={handleCreated}
          onPlantelCreated={(plantel) =>
            setPlanteles((prev) =>
              prev.some((item) => item.id === plantel.id)
                ? prev
                : [...prev, plantel].sort((a, b) => a.name.localeCompare(b.name, "es")),
            )
          }
        />
        <BulkCreateGroupsModal
          open={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          courses={courses}
          planteles={availablePlanteles}
          defaultPlantelId={primaryPlantelAssignment?.plantelId ?? ""}
          lockPlantel={isCampusCoordinator && availablePlanteles.length <= 1}
          allowCreatePlantel={isAdminTeacher}
          teacherOptions={teacherSelectOptions}
          defaultTeacherId={isAdminTeacher ? "" : currentUser?.uid ?? ""}
          lockTeacher={!isAdminTeacher}
          loadingTeacherOptions={loadingTeacherOptions}
          onImported={() => {
            loadGroupsData();
          }}
          onPlantelCreated={(plantel) =>
            setPlanteles((prev) =>
              prev.some((item) => item.id === plantel.id)
                ? prev
                : [...prev, plantel].sort((a, b) => a.name.localeCompare(b.name, "es")),
            )
          }
        />
      </div>
    </RoleGate>
  );
}

function QuickGroupsTable({
  rows,
  closureSummaries,
  formatRange,
}: {
  rows: Array<{ group: Group; relation: "Principal" | "Mentor" }>;
  closureSummaries: Record<string, GroupClosureSummary>;
  formatRange: (s?: Date | null, e?: Date | null) => string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
        No hay grupos para mostrar en tabla.
      </div>
    );
  }

  return (
    <section className="creator-card overflow-hidden rounded-2xl border">
      <div className="flex flex-col gap-1 border-b border-[#d9b1a1]/60 px-5 py-4">
        <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">Vista rápida</p>
        <h2 className="text-lg font-semibold text-[#551b22]">Grupos y materias asignadas</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[#d9b1a1]/60 text-left text-sm">
          <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
            <tr>
              <th className="px-5 py-3 font-semibold">Grupo</th>
              <th className="px-5 py-3 font-semibold">Materias</th>
              <th className="px-5 py-3 font-semibold">Profesor</th>
              <th className="px-5 py-3 font-semibold">Alumnos</th>
              <th className="px-5 py-3 font-semibold">Fechas</th>
              <th className="px-5 py-3 font-semibold">Cierres</th>
              <th className="px-5 py-3 font-semibold">Accion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
            {rows.map(({ group, relation }) => {
              const summary = closureSummaries[group.id] ?? EMPTY_GROUP_CLOSURE_SUMMARY;
              const statusLabel =
                group.status === "active" ? "Activo" : group.status === "finished" ? "Finalizado" : "Archivado";
              return (
                <tr key={`${relation}-${group.id}`} className="align-top">
                  <td className="min-w-64 px-5 py-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-[#551b22]">{group.groupName}</p>
                        {relation === "Mentor" ? (
                          <span className="rounded-full bg-[#f3e3db] px-2 py-0.5 text-[11px] font-semibold text-[#6e2d2d]">
                            Mentor
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-[#754848]">
                        {group.program || "Sin programa"} | {group.plantelName || "Sin plantel"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            group.status === "active"
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {statusLabel}
                        </span>
                        <span className="rounded-full bg-[#f3e3db] px-2 py-0.5 text-[11px] font-semibold text-[#6e2d2d]">
                          {group.isInPerson === true ? "Presencial" : "En linea"}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="min-w-80 px-5 py-4">
                    <div className="flex flex-wrap gap-2">
                      {getGroupCourseList(group).length > 0 ? (
                        getGroupCourseList(group).map((course) => (
                          <span
                            key={course.courseId}
                            className="rounded-full border border-[#d9b1a1]/70 bg-[#fffaf7] px-2.5 py-1 text-xs font-medium text-[#6e2d2d]"
                          >
                            {course.courseName}
                          </span>
                        ))
                      ) : (
                        <span className="text-[#754848]">Sin materias</span>
                      )}
                    </div>
                  </td>
                  <td className="min-w-48 px-5 py-4 text-[#754848]">
                    <p className="font-medium text-[#551b22]">{group.teacherName || "Sin profesor"}</p>
                    {group.assistantTeachers && group.assistantTeachers.length > 0 ? (
                      <p className="mt-1 text-xs">
                        Mentores: {group.assistantTeachers.map((teacher) => teacher.name || teacher.email || teacher.id).join(", ")}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 text-[#551b22]">
                    {group.studentsCount}/{group.maxStudents || "∞"}
                  </td>
                  <td className="min-w-44 px-5 py-4 text-[#754848]">
                    {formatRange(group.startDate, group.endDate)}
                  </td>
                  <td className="min-w-96 px-5 py-4 text-[#754848]">
                    {summary.loading ? (
                      <span>Cargando cierres...</span>
                    ) : summary.error ? (
                      <span className="text-red-600">{summary.error}</span>
                    ) : summary.courses.length === 0 ? (
                      <span>Sin materias para cierre</span>
                    ) : (
                      <div className="space-y-2">
                        {summary.courses.map((course) => (
                          <div key={course.courseId} className="rounded-lg border border-[#d9b1a1]/60 bg-white/70 p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium text-[#551b22]">{course.courseName}</span>
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                                {course.closedCount}/{course.totalCount} cerrados
                              </span>
                            </div>
                            <p className="mt-1 text-xs">
                              Ultimo cierre: {formatShortDate(course.lastClosedAt)}
                              {course.lastClosedByName ? ` por ${course.lastClosedByName}` : ""}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <Link
                      href={`/creator/grupos/${group.id}`}
                      className="inline-flex whitespace-nowrap rounded-lg border border-[#d9b1a1] bg-white px-3 py-2 text-sm font-medium text-[#6e2d2d] transition hover:border-[#b67a68] hover:bg-[#fff7f7]"
                    >
                      Gestionar
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
              <span className="inline-flex items-center rounded-full bg-[#f3e3db] px-2 py-0.5 text-[11px] font-semibold text-[#6e2d2d]">
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
          <span
            className={`mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              group.isInPerson === true
                ? "bg-emerald-100 text-emerald-700"
                : "bg-[#f3e3db] text-[#6e2d2d]"
            }`}
          >
            {group.isInPerson === true ? "Presencial" : "En línea"}
          </span>
          <p className="mt-1 text-xs text-slate-500">
            Plantel: {group.plantelName || "Sin plantel"}
          </p>
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
          className="inline-flex items-center rounded-lg border border-[#d9b1a1] bg-white px-3 py-2 text-sm font-medium text-[#6e2d2d] transition hover:border-[#b67a68] hover:bg-[#fff7f7]"
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
