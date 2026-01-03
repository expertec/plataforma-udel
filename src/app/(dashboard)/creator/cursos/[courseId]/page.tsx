"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
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
import toast from "react-hot-toast";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { auth } from "@/lib/firebase/client";
import { getGroupsByCourse, addStudentsToGroup } from "@/lib/firebase/groups-service";
import { getAlumnos } from "@/lib/firebase/alumnos-service";

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

  const lessonsDeduped = useMemo(() => {
    const map = new Map<string, Lesson>();
    lessons.forEach((l) => map.set(l.id, l));
    return Array.from(map.values());
  }, [lessons]);

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

    (async () => {
      setLoadingLessons(true);
      const lessonsRef = collection(db, "courses", courseId, "lessons");
      const q = query(lessonsRef, orderBy("order", "asc"));
      const unsub = onSnapshot(
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
      return unsub;
    })();

    (async () => {
      setLoadingGroups(true);
      try {
        const groups = await getGroupsByCourse(courseId);
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
      } finally {
        setLoadingGroups(false);
      }
    })();
    return () => {
      // Cleanup listeners de clases
      Object.values(classListeners.current).forEach((u) => u());
      classListeners.current = {};
      unsubCourse();
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
          <span className="text-xs text-slate-500">ID: {courseId}</span>
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
                    {courseInfo.thumbnail ? (
                      <div className="mt-2 flex items-center gap-3">
                        <Image
                          src={courseInfo.thumbnail}
                          alt="thumbnail preview"
                          width={96}
                          height={56}
                          className="h-14 w-24 rounded object-cover border border-slate-200"
                        />
                        <p className="text-xs text-slate-600 break-all">
                          {courseInfo.thumbnail}
                        </p>
                      </div>
                    ) : null}
                  </div>
                  <input
                    value={courseInfo.thumbnail ?? ""}
                    onChange={(e) =>
                      setCourseInfo((prev) => ({ ...prev, thumbnail: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
                {uploadingThumb ? (
                  <p className="text-xs text-slate-500">Subiendo imagen optimizada...</p>
                ) : null}
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
              onClick={async () => {
                setLoadingGroups(true);
                try {
                  const groups = await getGroupsByCourse(courseId);
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
                } finally {
                  setLoadingGroups(false);
                }
              }}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Refrescar
            </button>
          </div>

          {loadingGroups ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Cargando grupos vinculados a este curso...
            </div>
          ) : courseGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No hay grupos asociados a este curso. Crea un grupo en la sección de Grupos y regresa
              para vincular alumnos de prueba.
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
                </div>
              ))}
            </div>
          )}
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
    </div>
  );
}
