"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ClassItem as ClassData,
  Lesson,
  Course,
  updateCourse,
} from "@/lib/firebase/courses-service";
import { collection, doc, onSnapshot, orderBy, query, Unsubscribe } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { deleteClass, deleteLesson } from "@/lib/firebase/courses-service";
import { LessonItem } from "./_components/LessonItem";
import { AddLessonModal } from "./_components/AddLessonModal";
import { AddClassModal } from "./_components/AddClassModal";
import { CommentsModal } from "./_components/CommentsModal";
import toast from "react-hot-toast";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { auth } from "@/lib/firebase/client";
import {
  getGroupsByCourse,
  addStudentsToGroup,
  createGroup,
  getActiveGroups,
  linkCourseToGroup,
  Group,
} from "@/lib/firebase/groups-service";
import { getAlumnos } from "@/lib/firebase/alumnos-service";
import { resolveUserRole, UserRole } from "@/lib/firebase/roles";
import { EntregasTab } from "@/app/(dashboard)/creator/grupos/[groupId]/_components/EntregasTab";

type ConfirmState =
  | { open: false }
  | { open: true; message: string; onConfirm: () => Promise<void> | void };

async function compressImage(file: File, maxSize = 1280, quality = 0.72): Promise<Blob> {
  const img = document.createElement("img");
  const url = URL.createObjectURL(file);
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas context");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("No blob"));
        URL.revokeObjectURL(url);
      },
      "image/jpeg",
      quality,
    );
  });
}

export default function CourseBuilderPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const router = useRouter();
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [classesMap, setClassesMap] = useState<Record<string, ClassData[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingLessons, setLoadingLessons] = useState(true);
  const [loadingClasses, setLoadingClasses] = useState<Record<string, boolean>>({});
  const [addLessonOpen, setAddLessonOpen] = useState(false);
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [classModalMode, setClassModalMode] = useState<"create" | "edit">("create");
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [editingClass, setEditingClass] = useState<{ lesson: Lesson; classItem: ClassData } | null>(
    null,
  );
  const [commentsTarget, setCommentsTarget] = useState<{
    open: boolean;
    lesson: Lesson | null;
    classItem: ClassData | null;
  }>({ open: false, lesson: null, classItem: null });
  const classListeners = useRef<Record<string, Unsubscribe>>({});
  const [confirmState, setConfirmState] = useState<ConfirmState>({ open: false });
  const [activeTab, setActiveTab] = useState<"info" | "lessons" | "groups">("info");
  const [courseInfo, setCourseInfo] = useState<Partial<Course> | null>(null);
  const [savingInfo, setSavingInfo] = useState(false);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const [thumbDragOver, setThumbDragOver] = useState(false);
  const [courseGroups, setCourseGroups] = useState<
    Array<{
      id: string;
      groupName: string;
      semester: string;
      status: string;
      studentsCount: number;
      maxStudents: number;
    }>
  >([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupSemester, setNewGroupSemester] = useState("2025-Q1");
  const [newGroupMax, setNewGroupMax] = useState(30);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [linkingGroup, setLinkingGroup] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [currentUser, setCurrentUser] = useState(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const [submissionsGroup, setSubmissionsGroup] = useState<{
    id: string;
    name: string;
    studentsCount: number;
  } | null>(null);
  const [groupLinkModalOpen, setGroupLinkModalOpen] = useState(false);

  const lessonsDeduped = useMemo(() => {
    const map = new Map<string, Lesson>();
    lessons.forEach((l) => map.set(l.id, l));
    return Array.from(map.values());
  }, [lessons]);
  const canManageGroups = userRole === "adminTeacher";
  const canLinkGroups = userRole === "adminTeacher" || userRole === "teacher";

  const handleThumbnailFile = async (file: File) => {
    if (!courseId) return;
    setUploadingThumb(true);
    try {
      const compressed = await compressImage(file, 1280, 0.72);
      const storage = getStorage();
      const userId = auth.currentUser?.uid ?? "anon";
      const storageRef = ref(storage, `thumbnails/${userId}/${courseId}.jpg`);
      await uploadBytes(storageRef, compressed, {
        contentType: "image/jpeg",
      });
      const url = await getDownloadURL(storageRef);
      setCourseInfo((prev) => ({ ...prev, thumbnail: url }));
      toast.success("Thumbnail actualizado");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo subir la imagen");
    } finally {
      setUploadingThumb(false);
    }
  };

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    const unsubAuth = auth.onAuthStateChanged(async (u) => {
      if (cancelled) return;
      setCurrentUser(u);
      if (!u) {
        setUserRole(null);
        setRoleLoading(false);
        return;
      }
      setRoleLoading(true);
      try {
        const role = await resolveUserRole(u);
        if (!cancelled) setUserRole(role);
      } catch {
        if (!cancelled) setUserRole(null);
      } finally {
        if (!cancelled) setRoleLoading(false);
      }
    });
    const courseRef = doc(db, "courses", courseId);
    const unsubCourse = onSnapshot(courseRef, (snap) => {
      const d = snap.data();
      if (d) {
        setCourseInfo({
          id: snap.id,
          title: d.title ?? "",
          description: d.description ?? "",
          introVideoUrl: d.introVideoUrl ?? "",
          category: d.category ?? "",
          thumbnail: d.thumbnail ?? "",
          isPublished: d.isPublished ?? false,
        });
      }
    });
    setLoadingLessons(true);
    const lessonsRef = collection(db, "courses", courseId, "lessons");
    const q = query(lessonsRef, orderBy("order", "asc"));
    const unsubLessons = onSnapshot(
      q,
      (snap) => {
        const data: Lesson[] = snap.docs.map((doc) => {
          const d = doc.data();
          return {
            id: doc.id,
            lessonNumber: d.lessonNumber ?? d.order ?? 1,
            title: d.title ?? "Lección sin título",
            description: d.description ?? "",
            order: d.order ?? 0,
          };
        });
        setLessons(data);
        setLoadingLessons(false);
      },
      () => {
        setLoadingLessons(false);
      },
    );
    return () => {
      cancelled = true;
      // Cleanup listeners de clases
      Object.values(classListeners.current).forEach((u) => u());
      classListeners.current = {};
      unsubCourse();
      unsubLessons();
      unsubAuth();
    };
  }, [courseId]);

  const ensureClassListener = (lessonId: string) => {
    if (!courseId) return;
    if (classListeners.current[lessonId]) return;
    setLoadingClasses((prev) => ({ ...prev, [lessonId]: true }));
    const classesRef = collection(db, "courses", courseId, "lessons", lessonId, "classes");
    const q = query(classesRef, orderBy("order", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data: ClassData[] = snap.docs.map((doc) => {
          const d = doc.data();
          return {
            id: doc.id,
            title: d.title ?? "Clase sin título",
            type: d.type ?? "video",
            order: d.order ?? 0,
            duration: d.duration,
            videoUrl: d.videoUrl ?? "",
            audioUrl: d.audioUrl ?? "",
            content: d.content ?? "",
            imageUrls: d.imageUrls ?? [],
            hasAssignment: d.hasAssignment ?? false,
            assignmentTemplateUrl: d.assignmentTemplateUrl ?? "",
            forumEnabled: d.forumEnabled ?? false,
            forumRequiredFormat: d.forumRequiredFormat ?? null,
          };
        });
        setClassesMap((prev) => ({ ...prev, [lessonId]: data }));
        setLoadingClasses((prev) => ({ ...prev, [lessonId]: false }));
      },
      () => setLoadingClasses((prev) => ({ ...prev, [lessonId]: false })),
    );
    classListeners.current[lessonId] = unsub;
  };

  const toggleLesson = async (lessonId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lessonId)) next.delete(lessonId);
      else next.add(lessonId);
      return next;
    });
    ensureClassListener(lessonId);
  };

  const refreshGroups = async () => {
    if (!courseId || !currentUser) return;
    setLoadingGroups(true);
    try {
      const [groups, activeGroups] = await Promise.all([
        getGroupsByCourse(courseId, userRole === "adminTeacher" ? undefined : currentUser.uid),
        getActiveGroups(userRole === "adminTeacher" ? undefined : currentUser.uid),
      ]);
      setCourseGroups(
        groups.map((g) => ({
          id: g.id,
          groupName: g.groupName,
          semester: g.semester,
          status: g.status,
          studentsCount: g.studentsCount,
          maxStudents: g.maxStudents,
        })),
      );
      setAllGroups(activeGroups);
    } finally {
      setLoadingGroups(false);
    }
  };

  useEffect(() => {
    if (roleLoading) return;
    if (currentUser?.uid && courseId) {
      refreshGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, courseId, roleLoading]);

  const handleCreateGroupFromCourse = async () => {
    if (!courseId) return;
    const user = auth.currentUser;
    if (!user) {
      toast.error("Debes iniciar sesión para crear un grupo");
      return;
    }
    if (!canManageGroups) {
      toast.error("Solo un adminTeacher puede crear grupos");
      return;
    }
    if (!newGroupName.trim()) {
      toast.error("Asigna un nombre al grupo");
      return;
    }
    if (newGroupMax <= 0) {
      toast.error("El cupo debe ser mayor a 0");
      return;
    }
    setCreatingGroup(true);
    try {
      const courseTitle = courseInfo?.title ?? "Curso";
      const groupId = await createGroup({
        courseId,
        courseName: courseTitle,
        courses: [{ courseId, courseName: courseTitle }],
        groupName: newGroupName.trim(),
        teacherId: user.uid,
        teacherName: user.displayName ?? "Profesor",
        semester: newGroupSemester,
        maxStudents: newGroupMax,
      });
      setCourseGroups((prev) => [
        {
          id: groupId,
          groupName: newGroupName.trim(),
          semester: newGroupSemester,
          status: "active",
          studentsCount: 0,
          maxStudents: newGroupMax,
        },
        ...prev,
      ]);
      setNewGroupName("");
      setNewGroupMax(30);
      toast.success("Grupo creado y asociado a este curso");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear el grupo");
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleLinkExistingGroup = async () => {
    if (!courseId) return;
    if (!selectedGroupId) {
      toast.error("Selecciona un grupo");
      return;
    }
    if (!canLinkGroups) {
      toast.error("No tienes permiso para vincular grupos");
      return;
    }
    const selectedGroup = allGroups.find((g) => g.id === selectedGroupId);
    if (!selectedGroup) {
      toast.error("Grupo inválido");
      return;
    }
    setLinkingGroup(true);
    try {
      await linkCourseToGroup({
        groupId: selectedGroupId,
        courseId,
        courseName: courseInfo?.title ?? "Curso",
      });
      toast.success("Grupo vinculado a esta materia");
      await refreshGroups();
      setSelectedGroupId("");
      setGroupSearch("");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo vincular el grupo");
    } finally {
      setLinkingGroup(false);
    }
  };

  const filteredGroups = useMemo(() => {
    const term = groupSearch.toLowerCase().trim();
    if (!term) return allGroups;
    return allGroups.filter(
      (g) =>
        g.groupName.toLowerCase().includes(term) ||
        g.semester.toLowerCase().includes(term) ||
        g.courseName?.toLowerCase?.()?.includes(term),
    );
  }, [allGroups, groupSearch]);

  const handleLessonCreated = (
    lessonId: string,
    payload: { lessonNumber: number; title: string; description: string; order: number },
  ) => {
    // Evita duplicados: el snapshot en tiempo real actualizará la lista.
    setLessons((prev) => {
      if (prev.some((l) => l.id === lessonId)) return prev;
      return [
        ...prev,
        {
          id: lessonId,
          lessonNumber: payload.lessonNumber,
          title: payload.title,
          description: payload.description,
          order: payload.order,
        },
      ];
    });
  };

  const handleDeleteLesson = async (lessonId: string) => {
    if (!courseId) return;
    setConfirmState({
      open: true,
      message: "¿Eliminar lección y todas sus clases?",
      onConfirm: async () => {
        try {
          await deleteLesson(courseId, lessonId);
          setLessons((prev) => prev.filter((l) => l.id !== lessonId));
          setClassesMap((prev) => {
            const copy = { ...prev };
            delete copy[lessonId];
            return copy;
          });
          if (classListeners.current[lessonId]) {
            classListeners.current[lessonId]();
            const copy = { ...classListeners.current };
            delete copy[lessonId];
            classListeners.current = copy;
          }
          toast.success("Lección eliminada");
        } catch (err) {
          console.error(err);
          toast.error("No se pudo eliminar la lección");
        } finally {
          setConfirmState({ open: false });
        }
      },
    });
  };

  const handleDeleteClass = async (lessonId: string, classId: string) => {
    if (!courseId) return;
    setConfirmState({
      open: true,
      message: "¿Eliminar esta clase?",
      onConfirm: async () => {
        try {
          await deleteClass(courseId, lessonId, classId);
          setClassesMap((prev) => ({
            ...prev,
            [lessonId]: (prev[lessonId] || []).filter((c) => c.id !== classId),
          }));
          toast.success("Clase eliminada");
        } catch (err) {
          console.error(err);
          toast.error("No se pudo eliminar la clase");
        } finally {
          setConfirmState({ open: false });
        }
      },
    });
  };

  const nextLessonNumber = lessons.length + 1;

  const selectedClassesCount = useMemo(
    () => (lessonId: string) => classesMap[lessonId]?.length ?? 0,
    [classesMap],
  );

  const handleOpenAddClass = (lesson: Lesson) => {
    setSelectedLesson(lesson);
    setClassModalMode("create");
    setEditingClass(null);
    setAddClassOpen(true);
    if (!classesMap[lesson.id]) {
      ensureClassListener(lesson.id);
    }
  };

  const handleClassCreated = (
    classId: string,
    payload: { title: string; type: string; duration?: number; hasAssignment?: boolean },
  ) => {
    if (!selectedLesson) return;
    if (classListeners.current[selectedLesson.id]) {
      // Escuchamos en tiempo real; snapshot actualizará la lista evitando duplicados.
      return;
    }
    setClassesMap((prev) => ({
      ...prev,
      [selectedLesson.id]: [
        ...(prev[selectedLesson.id] || []),
        {
          id: classId,
          title: payload.title,
          type: payload.type as ClassData["type"],
          order: selectedClassesCount(selectedLesson.id),
          duration: payload.duration,
          hasAssignment: payload.hasAssignment ?? false,
        },
      ],
    }));
  };

  // ya no se usa selector de preguntas desde el listado

  const handleEditClass = (lesson: Lesson, classItem: ClassData) => {
    setSelectedLesson(lesson);
    setClassModalMode("edit");
    setEditingClass({ lesson, classItem });
    setAddClassOpen(true);
    if (!classesMap[lesson.id]) {
      ensureClassListener(lesson.id);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/creator/cursos")}
            className="text-sm text-blue-600 hover:underline"
          >
            ← Volver a cursos
          </button>
          <div className="flex items-center gap-3">
            <Link
              href={`/student?previewCourseId=${courseId}`}
              target="_blank"
              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
            >
              Vista previa alumno
            </Link>
            <span className="text-xs text-slate-500">ID: {courseId}</span>
          </div>
        </div>
        <div className="mt-3">
          <h1 className="text-2xl font-semibold text-slate-900">
            Builder del curso
          </h1>
          <p className="text-sm text-slate-600">
            Próximamente aquí podrás editar lecciones, contenido y configuración
            del curso.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { key: "info", label: "Información" },
          { key: "lessons", label: "Lecciones" },
          { key: "groups", label: "Grupos" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as typeof activeTab)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              activeTab === tab.key
                ? "bg-blue-600 text-white shadow-sm"
                : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "info" ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Información del curso</h2>
          {courseInfo ? (
            <form
              className="mt-4 grid gap-4 sm:grid-cols-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!courseId) return;
                setSavingInfo(true);
                try {
                  await updateCourse(courseId, {
                    title: courseInfo.title,
                    description: courseInfo.description,
                    introVideoUrl: courseInfo.introVideoUrl,
                    category: courseInfo.category,
                    thumbnail: courseInfo.thumbnail,
                  });
                  toast.success("Información actualizada");
                } catch (err) {
                  console.error(err);
                  toast.error("No se pudo guardar");
                } finally {
                  setSavingInfo(false);
                }
              }}
            >
              <div className="sm:col-span-2">
                <label className="text-sm font-medium text-slate-800">Título</label>
                <input
                  value={courseInfo.title ?? ""}
                  onChange={(e) =>
                    setCourseInfo((prev) => ({ ...prev, title: e.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-sm font-medium text-slate-800">Descripción</label>
                <textarea
                  value={courseInfo.description ?? ""}
                  onChange={(e) =>
                    setCourseInfo((prev) => ({ ...prev, description: e.target.value }))
                  }
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-800">
                  URL video introducción
                </label>
                <input
                  value={courseInfo.introVideoUrl ?? ""}
                  onChange={(e) =>
                    setCourseInfo((prev) => ({ ...prev, introVideoUrl: e.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-800">Categoría</label>
                <input
                  value={courseInfo.category ?? ""}
                  onChange={(e) =>
                    setCourseInfo((prev) => ({ ...prev, category: e.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-sm font-medium text-slate-800">Thumbnail (URL)</label>
                <div className="mt-2 space-y-2">
                  <div
                    className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition ${
                      thumbDragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-slate-50"
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setThumbDragOver(true);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      setThumbDragOver(false);
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setThumbDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) {
                        await handleThumbnailFile(file);
                      }
                    }}
                  >
                    <p className="text-lg text-slate-500">Arrastra tu imagen aquí</p>
                    <p className="text-xs text-slate-500">o</p>
                    <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-blue-600">
                      <span className="rounded-md border border-blue-200 px-3 py-2 transition hover:bg-blue-50">
                        Buscar archivo
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) await handleThumbnailFile(file);
                        }}
                      />
                    </label>
                    {uploadingThumb ? (
                      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full w-3/4 animate-pulse rounded-full bg-blue-500/70" />
                      </div>
                    ) : null}
                    {courseInfo.thumbnail ? (
                      <div className="mt-2 flex items-center gap-3 rounded-md bg-blue-50 px-3 py-2">
                        <Image
                          src={courseInfo.thumbnail}
                          alt="thumbnail preview"
                          width={96}
                          height={56}
                          className="h-14 w-24 rounded object-cover border border-slate-200"
                        />
                        <span className="text-xs font-semibold text-blue-700">
                          Imagen subida
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {uploadingThumb ? (
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full w-3/4 animate-pulse rounded-full bg-blue-500/70" />
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="sm:col-span-2 flex justify-end gap-3">
                <button
                  type="submit"
                  disabled={savingInfo}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-60"
                >
                  {savingInfo ? "Guardando..." : "Guardar cambios"}
                </button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-slate-600">Cargando información...</p>
          )}
        </div>
      ) : null}

      {activeTab === "lessons" ? (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Lecciones</h2>
            <button
              onClick={() => setAddLessonOpen(true)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
            >
              + Agregar Lección
            </button>
          </div>

          {loadingLessons ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
              Cargando lecciones...
            </div>
          ) : lessonsDeduped.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
              Aún no hay lecciones. Crea la primera para comenzar.
            </div>
          ) : (
            <div className="space-y-3">
              {lessonsDeduped
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((lesson) => (
                  <LessonItem
                    key={lesson.id}
                    lesson={lesson}
                    expanded={expanded.has(lesson.id)}
                    onToggle={toggleLesson}
                    classes={classesMap[lesson.id] || []}
                    loadingClasses={loadingClasses[lesson.id]}
                    onAddClass={handleOpenAddClass}
                    onDeleteClass={handleDeleteClass}
                    onDeleteLesson={handleDeleteLesson}
                    onEditClass={handleEditClass}
                    onOpenComments={(lessonItem, classItem) =>
                      setCommentsTarget({ open: true, lesson: lessonItem, classItem })
                    }
                  />
                ))}
            </div>
          )}
        </>
      ) : null}

      {activeTab === "groups" ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Grupos de este curso</h2>
            <button
              type="button"
              onClick={refreshGroups}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Refrescar
            </button>
          </div>

          {canManageGroups ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                <div className="flex-1">
                  <label className="text-sm font-semibold text-slate-800">
                    Crear grupo para esta materia
                  </label>
                  <input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="Nombre del grupo (ej. Grupo A - Sem 1)"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-slate-800">Semestre</label>
                  <input
                    value={newGroupSemester}
                    onChange={(e) => setNewGroupSemester(e.target.value)}
                    className="mt-1 w-32 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-slate-800">Cupo</label>
                  <input
                    type="number"
                    min={1}
                    value={newGroupMax}
                    onChange={(e) => setNewGroupMax(Number(e.target.value))}
                    className="mt-1 w-24 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleCreateGroupFromCourse}
                  disabled={creatingGroup || !canManageGroups}
                  className="h-[42px] rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {creatingGroup ? "Creando..." : "Crear grupo"}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                El grupo se asociará automáticamente a esta materia y se podrá ver también en la sección de grupos.
              </p>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Grupos vinculados</h3>
            <button
              type="button"
              onClick={() => {
                setSelectedGroupId("");
                setGroupSearch("");
                setLinkingGroup(false);
                setGroupLinkModalOpen(true);
              }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
              aria-label="Abrir modal para asociar grupo existente"
              data-testid="open-link-group-modal"
            >
              Asociar grupo existente
            </button>
          </div>

          {loadingGroups ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Cargando grupos vinculados a este curso...
            </div>
          ) : courseGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No hay grupos asociados a este curso. Pide a un adminTeacher que cree el grupo y
              luego selecciónalo arriba para vincularlo.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {courseGroups.map((g) => (
                <div key={g.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-slate-900">{g.groupName}</p>
                  <p className="text-sm text-slate-600">Semestre: {g.semester}</p>
                  <p className="text-sm text-slate-600">
                    {g.studentsCount}/{g.maxStudents} estudiantes
                  </p>
                </div>
                <span className="text-xs font-semibold text-green-700 bg-green-50 rounded-full px-2 py-1">
                  {g.status}
                </span>
              </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-blue-600 hover:border-blue-400"
                      onClick={() =>
                        setSubmissionsGroup({
                          id: g.id,
                          name: g.groupName,
                          studentsCount: g.studentsCount,
                        })
                      }
                    >
                      Revisar entregas
                    </button>
                  </div>
                  {canManageGroups ? (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
                        onClick={async () => {
                          try {
                            setLoadingGroups(true);
                            const alumnos = await getAlumnos(10);
                            const pick = alumnos.slice(0, 3);
                            if (pick.length === 0) {
                              toast.error("No hay alumnos en la colección 'alumnos'");
                              return;
                            }
                            await addStudentsToGroup({
                              groupId: g.id,
                              students: pick.map((a) => ({
                                id: a.id,
                                nombre: a.nombre,
                                email: a.email,
                              })),
                            });
                            toast.success("Se añadieron alumnos de prueba al grupo");
                            setCourseGroups((prev) =>
                              prev.map((cg) =>
                                cg.id === g.id
                                  ? { ...cg, studentsCount: cg.studentsCount + pick.length }
                                  : cg,
                              ),
                            );
                          } catch (err) {
                            console.error(err);
                            toast.error("No se pudo agregar alumnos al grupo");
                          } finally {
                            setLoadingGroups(false);
                          }
                        }}
                      >
                        Añadir alumnos de prueba
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {groupLinkModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Asociar grupo existente
                </p>
                <p className="text-sm text-slate-600">
                  Selecciona uno de tus grupos actuales para asociarlo a esta materia.
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setGroupLinkModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="flex flex-col gap-2">
                <input
                  value={groupSearch}
                  onChange={(e) => {
                    setGroupSearch(e.target.value);
                    setSelectedGroupId("");
                  }}
                  placeholder="Busca por nombre, semestre o materia"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="max-h-60 overflow-auto rounded-lg border border-slate-200 bg-slate-50">
                  {filteredGroups.length === 0 ? (
                    <p className="p-3 text-xs text-slate-500">Sin resultados</p>
                  ) : (
                    <ul className="divide-y divide-slate-200">
                      {filteredGroups.map((g) => (
                        <li
                          key={g.id}
                          className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm transition hover:bg-white ${
                            selectedGroupId === g.id ? "bg-white" : ""
                          }`}
                          onClick={() => setSelectedGroupId(g.id)}
                        >
                          <div>
                            <p className="font-semibold text-slate-800">{g.groupName}</p>
                            <p className="text-xs text-slate-500">
                              {g.semester} • {g.courseName || "—"}
                            </p>
                          </div>
                          {selectedGroupId === g.id ? (
                            <span className="text-xs font-semibold text-blue-600">Seleccionado</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await handleLinkExistingGroup();
                    setGroupLinkModalOpen(false);
                  }}
                  disabled={linkingGroup || !selectedGroupId || !canLinkGroups}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {linkingGroup ? "Vinculando..." : "Vincular grupo"}
                </button>
                <p className="text-xs text-slate-500">
                  Si el grupo ya está asociado no se duplicará.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {submissionsGroup && courseId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-5xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Entregas
                </p>
                <h3 className="text-xl font-semibold text-slate-900">
                  {submissionsGroup.name}
                </h3>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setSubmissionsGroup(null)}
              >
                Cerrar
              </button>
            </div>
            <div className="mt-4">
              <EntregasTab
                groupId={submissionsGroup.id}
                courseIds={[courseId]}
                studentsCount={submissionsGroup.studentsCount}
              />
            </div>
          </div>
        </div>
      ) : null}

      <AddLessonModal
        open={addLessonOpen}
        onClose={() => setAddLessonOpen(false)}
        courseId={courseId}
        nextNumber={nextLessonNumber}
        onCreated={handleLessonCreated}
      />

      {selectedLesson && (
        <AddClassModal
          open={addClassOpen}
          onClose={() => {
            setAddClassOpen(false);
            setEditingClass(null);
            setClassModalMode("create");
          }}
          courseId={courseId}
          lessonId={selectedLesson.id}
          lessonTitle={selectedLesson.title}
          nextOrder={classesMap[selectedLesson.id]?.length ?? 0}
          mode={classModalMode}
          classId={editingClass?.classItem.id}
          initialData={editingClass?.classItem}
          onCreated={handleClassCreated}
          onUpdated={() => {
            // snapshot actualiza, pero podemos cerrar modales y limpiar
            setEditingClass(null);
          }}
        />
      )}

      {confirmState.open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <p className="text-base font-semibold text-slate-900">
              Confirmar acción
            </p>
            <p className="mt-2 text-sm text-slate-600">{confirmState.message}</p>
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmState({ open: false })}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => confirmState.onConfirm()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {commentsTarget.open && commentsTarget.lesson && commentsTarget.classItem ? (
        <CommentsModal
          isOpen={commentsTarget.open}
          onClose={() => setCommentsTarget({ open: false, lesson: null, classItem: null })}
          courseId={courseId}
          lessonId={commentsTarget.lesson.id}
          classId={commentsTarget.classItem.id}
          className={commentsTarget.classItem.title}
        />
      ) : null}
    </div>
  );
}
