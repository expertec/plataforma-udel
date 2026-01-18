"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import toast from "react-hot-toast";
import {
  ClassItem,
  createClass,
  createQuizQuestion,
  deleteQuizQuestion,
  getQuizQuestions,
  updateClass,
} from "@/lib/firebase/courses-service";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { auth } from "@/lib/firebase/client";
import { v4 as uuidv4 } from "uuid";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import ImageExtension from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";

const classTypes = [
  {
    key: "video",
    label: "Video",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M15 10.5V7a1 1 0 00-1-1H5.5A1.5 1.5 0 004 7.5v9A1.5 1.5 0 005.5 18H14a1 1 0 001-1v-3l4 3V7.5l-4 3z" />
      </svg>
    ),
  },
  {
    key: "text",
    label: "Texto",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M6 6h12M6 10h8M6 14h12M6 18h8" />
      </svg>
    ),
  },
  {
    key: "audio",
    label: "Audio",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M9 17V7l7-2v10m0 0a2 2 0 11-4 0 2 2 0 114 0z" />
      </svg>
    ),
  },
  {
    key: "image",
    label: "Imagen",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M4 7.5A1.5 1.5 0 015.5 6h13A1.5 1.5 0 0120 7.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 16.5v-9zm0 8l4-4 3 3 4-4 5 5" />
      </svg>
    ),
  },
  {
    key: "quiz",
    label: "Quiz",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M9 7l6 4-6 4V7z" />
      </svg>
    ),
  },
] as const;

type AddClassModalProps = {
  open: boolean;
  onClose: () => void;
  courseId: string;
  lessonId: string;
  lessonTitle: string;
  nextOrder: number;
  onCreated: (
    classId: string,
    payload: { title: string; type: string; duration?: number; hasAssignment?: boolean },
  ) => void;
  mode?: "create" | "edit";
  classId?: string;
  initialData?: ClassItem;
  onUpdated?: (
    classId: string,
    payload: { title: string; type: string; duration?: number; hasAssignment?: boolean },
  ) => void;
};

export function AddClassModal({
  open,
  onClose,
  courseId,
  lessonId,
  lessonTitle,
  nextOrder,
  onCreated,
  mode = "create",
  classId,
  initialData,
  onUpdated,
}: AddClassModalProps) {
  const [type, setType] = useState<"video" | "text" | "audio" | "quiz" | "image">("video");
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [dragVideo, setDragVideo] = useState(false);
  const [dragAudio, setDragAudio] = useState(false);
  const [imageMode, setImageMode] = useState<"single" | "carousel">("single");
  const [loadingQuiz, setLoadingQuiz] = useState(false);
  const [hasAssignment, setHasAssignment] = useState(false);
  const [templateUrl, setTemplateUrl] = useState("");
  const [templateUploading, setTemplateUploading] = useState(false);
  const [videoDescription, setVideoDescription] = useState("");
  const [showVideoPreview, setShowVideoPreview] = useState(false);
  const [showAudioPreview, setShowAudioPreview] = useState(false);
  const [audioCoverUrl, setAudioCoverUrl] = useState("");
  const [coverUploading, setCoverUploading] = useState(false);
  const [forumEnabled, setForumEnabled] = useState(false);
  const [forumFormat, setForumFormat] = useState<"text" | "audio" | "video">("text");
  const makeEmptyQuestion = () => ({
    id: uuidv4(),
    prompt: "",
    explanation: "",
    type: "multiple" as "multiple" | "truefalse" | "open",
    options: [
      { id: uuidv4(), text: "", isCorrect: true, feedback: "", correctFeedback: "", incorrectFeedback: "" },
      { id: uuidv4(), text: "", isCorrect: false, feedback: "", correctFeedback: "", incorrectFeedback: "" },
    ],
    answerText: "",
  });
  const [questions, setQuestions] = useState<
    Array<{
      id: string;
      prompt: string;
      explanation?: string;
      type: "multiple" | "truefalse" | "open";
      options: Array<{
        id: string;
        text: string;
        isCorrect: boolean;
        feedback?: string;
        correctFeedback?: string;
        incorrectFeedback?: string;
      }>;
      answerText?: string;
    }>
  >([makeEmptyQuestion()]);

  useEffect(() => {
    if (mode === "edit" && initialData) {
      setType(initialData.type);
      setTitle(initialData.title);
      setDuration(initialData.duration ?? undefined);
      setUrl(initialData.videoUrl ?? initialData.audioUrl ?? "");
      setShowVideoPreview(false);
      setContent(initialData.content ?? "");
      if (initialData.type === "video") {
        setVideoDescription(initialData.content ?? "");
      }
      setImageUrls(initialData.imageUrls ?? []);
      if (initialData.type === "audio") {
        setAudioCoverUrl(initialData.imageUrls?.[0] ?? "");
      } else {
        setAudioCoverUrl("");
      }
      setHasAssignment(initialData.hasAssignment ?? false);
      setTemplateUrl(initialData.assignmentTemplateUrl ?? "");
      setForumEnabled(initialData.forumEnabled ?? false);
      setForumFormat(
        initialData.forumRequiredFormat === "audio" || initialData.forumRequiredFormat === "video"
          ? initialData.forumRequiredFormat
          : "text",
      );
      if (initialData.type === "image" && (initialData.imageUrls?.length ?? 0) > 1) {
        setImageMode("carousel");
      } else {
        setImageMode("single");
      }
      if (initialData.type === "quiz" && classId && open) {
        setLoadingQuiz(true);
        getQuizQuestions(courseId, lessonId, classId)
          .then((qs) => {
            if (qs.length === 0) {
              setQuestions([makeEmptyQuestion()]);
              return;
            }
            setQuestions(
              qs.map((q) => ({
                id: q.id,
                prompt: q.prompt,
                explanation: q.explanation ?? "",
                type: q.type,
                options:
                  q.type === "open"
                    ? []
                    : q.options.map((o) => ({
                        id: o.id,
                        text: o.text,
                        isCorrect: o.isCorrect,
                        feedback: o.feedback ?? "",
                        correctFeedback: o.correctFeedback ?? "",
                        incorrectFeedback: o.incorrectFeedback ?? "",
                      })),
                answerText: q.answerText ?? "",
              })),
            );
          })
          .finally(() => setLoadingQuiz(false));
      }
    } else if (mode === "create") {
      setType("video");
      setTitle("");
      setDuration(undefined);
      setUrl("");
      setContent("");
      setImageUrls([]);
      setAudioCoverUrl("");
      setImageMode("single");
      setQuestions([makeEmptyQuestion()]);
      setHasAssignment(false);
      setTemplateUrl("");
      setShowVideoPreview(false);
      setVideoDescription("");
      setForumEnabled(false);
      setForumFormat("text");
    }
  }, [mode, initialData, open, courseId, lessonId, classId]);

  useEffect(() => {
    if (type !== "audio") {
      setShowAudioPreview(false);
    }
  }, [type]);

  const handleImageUpload = async (file: File) => {
    const user = auth.currentUser;
    if (!user) {
      toast.error("Inicia sesión para subir imágenes");
      throw new Error("Not authenticated");
    }
    const storage = getStorage();
    const ext = file.name.split(".").pop() || "jpg";
    const storageRef = ref(storage, `class-descriptions/${user.uid}/${uuidv4()}.${ext.toLowerCase()}`);
    const snapshot = await uploadBytes(storageRef, file, {
      contentType: file.type,
    });
    return getDownloadURL(snapshot.ref);
  };

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("El título es obligatorio");
      return;
    }
    // Validar contenido según el tipo de clase
    if (type === "video" && !url.trim()) {
      toast.error("Debes agregar un video o enlace de video");
      return;
    }
    if (type === "audio" && !url.trim()) {
      toast.error("Debes agregar un archivo de audio");
      return;
    }
    if (type === "image" && imageUrls.length === 0) {
      toast.error("Debes agregar al menos una imagen");
      return;
    }
    if (type === "quiz") {
      const hasQuestions = questions.length > 0;
      const everyQuestionValid = questions.every((q) => {
        const promptOk = q.prompt.trim().length > 0;
        if (q.type === "open") {
          return promptOk && (q.answerText?.trim().length ?? 0) > 0;
        }
        if (q.type === "truefalse") {
          const hasCorrect = q.options.some((o) => o.isCorrect);
          return promptOk && hasCorrect;
        }
        const opts = q.options.filter((o) => o.text.trim().length > 0);
        const hasMinOpts = opts.length >= 2;
        const hasCorrect = opts.some((o) => o.isCorrect);
        return promptOk && hasMinOpts && hasCorrect;
      });
      if (!hasQuestions || !everyQuestionValid) {
        toast.error("Agrega preguntas válidas (texto, respuesta y opción correcta)");
        return;
      }
    }
    const coverImageUrls =
      type === "image"
        ? imageUrls
        : type === "audio" && audioCoverUrl
        ? [audioCoverUrl]
        : [];
    setLoading(true);
    try {
      let savedClassId = classId;
      if (mode === "edit" && classId) {
        await updateClass({
          courseId,
          lessonId,
          classId,
          title: title.trim(),
          type,
          duration: type === "text" ? null : duration ?? null,
          videoUrl: type === "video" ? url : "",
          audioUrl: type === "audio" ? url : "",
          content:
            type === "video"
              ? videoDescription
              : type === "text" || type === "image" || type === "quiz"
              ? content
              : "",
          imageUrls: coverImageUrls,
          hasAssignment,
          assignmentTemplateUrl: hasAssignment ? templateUrl : "",
          forumEnabled,
          forumRequiredFormat: forumEnabled ? forumFormat : null,
        });
      } else {
        savedClassId = await createClass({
          courseId,
          lessonId,
          title: title.trim(),
          type,
          order: nextOrder,
          duration: type === "text" ? undefined : duration,
          videoUrl: type === "video" ? url : "",
          audioUrl: type === "audio" ? url : "",
          content:
            type === "video"
              ? videoDescription
              : type === "text" || type === "image" || type === "quiz"
              ? content
              : "",
          imageUrls: coverImageUrls,
          hasAssignment,
          assignmentTemplateUrl: hasAssignment ? templateUrl : "",
          forumEnabled,
          forumRequiredFormat: forumEnabled ? forumFormat : null,
        });
      }
      if (type === "quiz" && savedClassId) {
        // Si estamos editando, eliminamos preguntas anteriores y recreamos
        if (mode === "edit") {
          const prevQuestions = await getQuizQuestions(courseId, lessonId, savedClassId);
          await Promise.all(
            prevQuestions.map((q) => deleteQuizQuestion(courseId, lessonId, savedClassId, q.id)),
          );
        }
        const trimmed = questions.map((q, idx) => {
          if (q.type === "multiple") {
            return {
              prompt: q.prompt.trim(),
              order: idx,
              type: "multiple" as const,
              options: q.options
                .filter((o) => o.text.trim().length > 0)
                .map((o) => ({
                  ...o,
                  text: o.text.trim(),
                  feedback: (o.feedback ?? "").trim(),
                  correctFeedback: (o.correctFeedback ?? "").trim(),
                  incorrectFeedback: (o.incorrectFeedback ?? "").trim(),
                })),
            };
          }
          if (q.type === "truefalse") {
            const opts = q.options.map((o) => ({
              ...o,
              text: o.text.trim().toLowerCase(),
              feedback: (o.feedback ?? "").trim(),
              correctFeedback: (o.correctFeedback ?? "").trim(),
              incorrectFeedback: (o.incorrectFeedback ?? "").trim(),
            }));
            const isTrueCorrect = q.options.some(
              (o) => o.isCorrect && o.text.toLowerCase().startsWith("verdadero"),
            );
            const isFalseCorrect = q.options.some(
              (o) => o.isCorrect && o.text.toLowerCase().startsWith("falso"),
            );
            const trueOpt = {
              id: uuidv4(),
              text: "Verdadero",
              isCorrect: isTrueCorrect || (!isTrueCorrect && !isFalseCorrect),
              feedback: opts.find((o) => o.text.startsWith("verdadero"))?.feedback ?? "",
              correctFeedback: opts.find((o) => o.text.startsWith("verdadero"))?.correctFeedback ?? "",
              incorrectFeedback: opts.find((o) => o.text.startsWith("verdadero"))?.incorrectFeedback ?? "",
            };
            const falseOpt = {
              id: uuidv4(),
              text: "Falso",
              isCorrect: isFalseCorrect && !trueOpt.isCorrect,
              feedback: opts.find((o) => o.text.startsWith("falso"))?.feedback ?? "",
              correctFeedback: opts.find((o) => o.text.startsWith("falso"))?.correctFeedback ?? "",
              incorrectFeedback: opts.find((o) => o.text.startsWith("falso"))?.incorrectFeedback ?? "",
            };
            return {
              prompt: q.prompt.trim(),
              order: idx,
              type: "truefalse" as const,
              options: [trueOpt, falseOpt],
            };
          }
          if (q.type === "open") {
            return {
              prompt: q.prompt.trim(),
              order: idx,
              type: "open" as const,
              options: [],
              answerText: q.answerText?.trim() ?? "",
            };
          }
          return {
            prompt: q.prompt.trim(),
            order: idx,
            type: "multiple" as const,
            options: q.options
              .filter((o) => o.text.trim().length > 0)
              .map((o) => ({
                ...o,
                text: o.text.trim(),
                feedback: (o.feedback ?? "").trim(),
                correctFeedback: (o.correctFeedback ?? "").trim(),
                incorrectFeedback: (o.incorrectFeedback ?? "").trim(),
              })),
          };
        });
        await Promise.all(
          trimmed.map((q) =>
            createQuizQuestion({
              courseId,
              lessonId,
              classId: savedClassId!,
              prompt: q.prompt,
              options: q.options,
              order: q.order,
              type: q.type,
              answerText: q.type === "open" ? q.answerText : undefined,
            }),
          ),
        );
      }
      if (mode === "edit" && savedClassId && onUpdated) {
        onUpdated(savedClassId, { title: title.trim(), type, duration, hasAssignment });
      } else if (savedClassId) {
        onCreated(savedClassId, { title: title.trim(), type, duration, hasAssignment });
      }
      toast.success(mode === "edit" ? "Clase actualizada" : "Clase creada");
      setTitle("");
      setDuration(undefined);
      setUrl("");
      setContent("");
      setImageUrls([]);
      setQuestions([makeEmptyQuestion()]);
      setHasAssignment(false);
      setTemplateUrl("");
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear la clase");
    } finally {
      setLoading(false);
    }
  };
  const handleImageFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
    const selectedFiles =
      imageMode === "single" ? Array.from(files).slice(0, 1) : Array.from(files);
    const list = {
      ...selectedFiles,
      length: selectedFiles.length,
      item: (idx: number) => selectedFiles[idx],
    } as unknown as FileList;
      const urls = await uploadFiles(list, "image");
      setImageUrls((prev) =>
        imageMode === "single"
          ? [urls[0]].filter(Boolean)
          : Array.from(new Set([...(prev ?? []), ...urls])),
      );
      toast.success("Imágenes subidas");
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron subir las imágenes");
    } finally {
      setUploading(false);
    }
  };
  const handleAudioCoverFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setCoverUploading(true);
    try {
      const urls = await uploadFiles(files, "image");
      if (urls.length > 0) {
        setAudioCoverUrl(urls[0]);
      }
    } catch (err) {
      console.error("No se pudo subir la portada del audio:", err);
      toast.error("No se pudo subir la portada del audio");
    } finally {
      setCoverUploading(false);
    }
  };

  const handleMediaFiles = async (files: FileList | null, mediaType: "video" | "audio") => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const urls = await uploadFiles(files, mediaType);
      setUrl(urls[0] ?? "");
      toast.success(`${mediaType === "video" ? "Video" : "Audio"} subido`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo subir el archivo");
    } finally {
      setUploading(false);
    }
  };

  const uploadFiles = async (files: FileList, mediaType: "video" | "audio" | "image") => {
    const storage = getStorage();
    const userId = auth.currentUser?.uid ?? "anon";

    const compressImage = async (file: File, maxSize = 1600, quality = 0.76): Promise<Blob> => {
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
    };

    const uploads = Array.from(files).map(async (file) => {
      let blob: Blob = file;
      let extension = file.name.split(".").pop() || "bin";
      let contentType = file.type || "application/octet-stream";
      if (mediaType === "image") {
        blob = await compressImage(file, 1600, 0.76);
        extension = "jpg";
        contentType = "image/jpeg";
      }
      const key = uuidv4();
      const storageRef = ref(
        storage,
        `class-media/${userId}/${courseId}/${lessonId}/${key}.${extension}`,
      );
      await uploadBytes(storageRef, blob, {
        contentType,
      });
      return getDownloadURL(storageRef);
    });
    return Promise.all(uploads);
  };

  const handleTemplateFile = async (file: File) => {
    try {
      const storage = getStorage();
      const userId = auth.currentUser?.uid ?? "anon";
      const ext = file.name.split(".").pop() || "bin";
      const storageRef = ref(
        storage,
        `class-templates/${userId}/${courseId}/${lessonId}/${uuidv4()}.${ext}`,
      );
      await uploadBytes(storageRef, file, { contentType: file.type || undefined });
      const url = await getDownloadURL(storageRef);
      setTemplateUrl(url);
      toast.success("Plantilla subida");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo subir la plantilla");
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-6">
      <div className="w-full max-w-xl max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Agregar Clase a: {lessonTitle}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div className="grid grid-cols-5 gap-2">
                  {classTypes.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => {
                        setType(t.key);
                        if (t.key === "quiz" && questions.length === 0) {
                          setQuestions([makeEmptyQuestion()]);
                        }
                      }}
                className={`flex flex-col items-center rounded-lg border px-2 py-3 text-sm font-medium transition ${
                  type === t.key
                    ? "border-blue-500 bg-blue-50 text-blue-600"
                    : "border-slate-200 bg-white text-slate-700 hover:border-blue-200"
                }`}
              >
                <span className="text-lg">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">
              Título *
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {type === "video" ? (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">
                Descripción del video
              </label>
              <RichTextEditor
                value={videoDescription}
                onChange={setVideoDescription}
                placeholder="Escribe una breve descripción del video"
                onUploadImage={handleImageUpload}
              />
            </div>
          ) : null}

          {type === "text" ? (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Contenido de la clase</label>
              <RichTextEditor
                value={content}
                onChange={setContent}
                placeholder="Escribe el contenido y agrega imágenes"
                onUploadImage={handleImageUpload}
              />
            </div>
          ) : null}

          {/* Asignación */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">Habilitar tarea</p>
                <p className="text-xs text-slate-600">
                  Si está activo, los alumnos podrán subir una entrega para esta clase.
                </p>
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <span className="text-xs text-slate-600">No</span>
                <div
                  role="switch"
                  aria-checked={hasAssignment}
                  tabIndex={0}
                  onClick={() => setHasAssignment((prev) => !prev)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setHasAssignment((prev) => !prev);
                    }
                  }}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                    hasAssignment ? "bg-blue-500" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${
                      hasAssignment ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </div>
                <span className="text-xs text-slate-600">Sí</span>
              </label>
            </div>

            {hasAssignment ? (
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-800">
                  Plantilla opcional (doc/pdf)
                </label>
                <div
                  className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-4 text-center text-sm transition ${
                    templateUploading ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-white"
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setTemplateUploading(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setTemplateUploading(false);
                  }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setTemplateUploading(true);
                    if (e.dataTransfer.files?.length) {
                      await handleTemplateFile(e.dataTransfer.files[0]);
                    }
                    setTemplateUploading(false);
                  }}
                >
                  <p className="text-sm text-slate-500">Arrastra un archivo aquí</p>
                  <p className="text-xs text-slate-500">o</p>
                  <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-blue-600">
                    <span className="rounded-md border border-blue-200 px-3 py-2 transition hover:bg-blue-50">
                      Buscar archivo
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setTemplateUploading(true);
                          await handleTemplateFile(file);
                          setTemplateUploading(false);
                        }
                      }}
                    />
                  </label>
                  {templateUploading ? (
                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full w-3/4 animate-pulse rounded-full bg-blue-500/70" />
                    </div>
                  ) : null}
                  {templateUrl ? (
                    <div className="mt-3 flex w-full items-center justify-between rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
                      <span className="font-semibold">Plantilla cargada</span>
                      <span className="truncate text-[11px] text-green-600/80">Archivo listo</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          {/* Foro */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">Foro obligatorio</p>
                <p className="text-xs text-slate-600">
                  Si está activo, el alumno debe participar en el foro para avanzar.
                </p>
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <span className="text-xs text-slate-600">No</span>
                <div
                  role="switch"
                  aria-checked={forumEnabled}
                  tabIndex={0}
                  onClick={() => setForumEnabled((prev) => !prev)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setForumEnabled((prev) => !prev);
                    }
                  }}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                    forumEnabled ? "bg-blue-500" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${
                      forumEnabled ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </div>
                <span className="text-xs text-slate-600">Sí</span>
              </label>
            </div>

            {forumEnabled ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium text-slate-800">Formato requerido</label>
                  <select
                    value={forumFormat}
                    onChange={(e) => setForumFormat(e.target.value as "text" | "audio" | "video")}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="text">Texto</option>
                    <option value="audio">Audio</option>
                    <option value="video">Video</option>
                  </select>
                </div>
                <p className="text-xs text-slate-600 sm:col-span-2">
                  El alumno deberá enviar al menos un aporte en este formato para desbloquear la siguiente clase.
                </p>
              </div>
            ) : null}
          </div>

          {type === "image" ? (
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-800">
                    Imágenes ({imageMode === "single" ? "una" : "múltiples"})
                  </label>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-slate-700">Imagen + texto</span>
                    <div
                      role="switch"
                      aria-checked={imageMode === "carousel"}
                      tabIndex={0}
                      onClick={() =>
                        setImageMode((prev) => {
                          if (prev === "single") {
                            return "carousel";
                          }
                          // Si regresa a single, limpiamos previas
                          setImageUrls([]);
                          return "single";
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setImageMode((prev) => {
                            if (prev === "single") {
                              return "carousel";
                            }
                            setImageUrls([]);
                            return "single";
                          });
                        }
                      }}
                      className={`relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full transition ${
                        imageMode === "carousel" ? "bg-blue-500" : "bg-slate-300"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${
                          imageMode === "carousel" ? "translate-x-5" : "translate-x-1"
                        }`}
                      />
                    </div>
                    <span className="text-sm text-slate-700">Carrusel de imágenes</span>
                  </div>
                </div>
              <div
                className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition ${
                  dragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-slate-50"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOver(false);
                  await handleImageFiles(e.dataTransfer.files);
                }}
              >
                <p className="text-lg text-slate-500">Arrastra las imágenes aquí</p>
                <p className="text-xs text-slate-500">o</p>
                <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-blue-600">
                  <span className="rounded-md border border-blue-200 px-3 py-2 transition hover:bg-blue-50">
                    Buscar archivos
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple={imageMode === "carousel"}
                    className="hidden"
                    onChange={async (e) => {
                      await handleImageFiles(e.target.files);
                    }}
                  />
                </label>
              </div>
              {uploading ? (
                <p className="text-xs text-slate-500">Subiendo y comprimiendo...</p>
              ) : null}
              {imageUrls.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {imageUrls.map((u) => (
                    <div key={u} className="relative">
                      <Image
                        src={u}
                        alt="preview"
                        width={64}
                        height={64}
                        className="h-16 w-16 rounded object-cover border border-slate-200"
                      />
                      <button
                        type="button"
                        onClick={() => setImageUrls((prev) => prev.filter((url) => url !== u))}
                        className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-semibold text-red-500 shadow"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div>
                <label className="text-sm font-medium text-slate-800">
                  Texto / descripción
                </label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder={
                    imageMode === "single"
                      ? "Texto acompañando a la imagen"
                      : "Texto opcional para el carrusel"
                  }
                />
              </div>
            </div>
          ) : type === "video" || type === "audio" ? (
            <div className="space-y-3">
              <div />
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-800">
                  {type === "video" ? "Video" : "Audio"}
                </label>
                {(() => {
                  const dropClass =
                    type === "video"
                      ? dragVideo
                        ? "border-blue-400 bg-blue-50"
                        : "border-slate-300 bg-slate-50"
                      : dragAudio
                      ? "border-blue-400 bg-blue-50"
                      : "border-slate-300 bg-slate-50";
                  return (
                    <div
                      className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-3 py-4 text-center text-sm transition ${dropClass}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (type === "video") {
                          setDragVideo(true);
                        } else {
                          setDragAudio(true);
                        }
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault();
                        if (type === "video") {
                          setDragVideo(false);
                        } else {
                          setDragAudio(false);
                        }
                      }}
                      onDrop={async (e) => {
                        e.preventDefault();
                        if (type === "video") {
                          setDragVideo(false);
                        } else {
                          setDragAudio(false);
                        }
                        await handleMediaFiles(
                          e.dataTransfer.files,
                          type === "video" ? "video" : "audio",
                        );
                      }}
                    >
                      <p className="text-sm text-slate-500">
                        Arrastra tu {type === "video" ? "video" : "audio"} aquí
                      </p>
                      <p className="text-xs text-slate-500">o</p>
                      <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-blue-600">
                        <span className="rounded-md border border-blue-200 px-3 py-2 transition hover:bg-blue-50">
                          Buscar archivo
                        </span>
                        <input
                          type="file"
                          accept={type === "video" ? "video/*" : "audio/*"}
                          className="hidden"
                          onChange={async (e) => {
                            await handleMediaFiles(
                              e.target.files,
                              type === "video" ? "video" : "audio",
                            );
                          }}
                        />
                      </label>
                    </div>
                  );
                })()}
                {type === "audio" ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-800">
                      Portada del audio (opcional)
                    </label>
                    {audioCoverUrl ? (
                      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white/80 px-3 py-2 shadow">
                        <div className="h-20 w-20 overflow-hidden rounded-lg bg-slate-100">
                          <Image
                            src={audioCoverUrl}
                            alt="Portada del audio"
                            width={80}
                            height={80}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="flex-1 text-sm text-slate-700">
                          <p className="font-semibold text-slate-900">Portada cargada</p>
                          <p className="text-xs text-slate-500">Se mostrará en el reproductor</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAudioCoverUrl("")}
                          className="rounded-full border border-slate-300 px-2 py-1 text-xs font-semibold text-red-600 transition hover:border-red-400 hover:text-red-500"
                        >
                          Quitar
                        </button>
                      </div>
                    ) : (
                      <label className="inline-flex w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 transition hover:border-blue-500 hover:text-blue-600">
                        <span>Cargar portada del audio</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={async (e) => {
                            await handleAudioCoverFiles(e.target.files);
                          }}
                        />
                      </label>
                    )}
                    {coverUploading ? (
                      <p className="text-xs text-slate-500">Subiendo portada...</p>
                    ) : null}
                  </div>
                ) : null}
                {uploading ? (
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full w-3/4 animate-pulse rounded-full bg-blue-500/70" />
                  </div>
                ) : null}
                {type === "video" ? (
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-800">
                      URL de video (Vimeo/YouTube o archivo subido)
                    </label>
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://vimeo.com/123456789 o https://player.vimeo.com/video/123456789"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <p className="text-xs text-slate-500">
                      Pega un link de Vimeo/YouTube o usa el archivo subido arriba.
                    </p>
                  </div>
                ) : null}
                {!uploading && url && type === "video" ? (
                  <div className="mt-3 space-y-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">Video subido</p>
                        <p className="text-xs text-green-700">Listo para previsualizar.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowVideoPreview((prev) => !prev)}
                        className="rounded-full bg-green-600 px-3 py-1 text-xs font-semibold text-white hover:bg-green-500"
                      >
                        {showVideoPreview ? "Ocultar" : "Ver video"}
                      </button>
                    </div>
                    {showVideoPreview ? (
                      <div className="overflow-hidden rounded-md border border-green-100 bg-white shadow-inner">
                        <video
                          src={url}
                          controls
                          className="aspect-video w-full bg-black"
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {!uploading && url && type === "audio" ? (
                  <div className="mt-3 space-y-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">Audio cargado</p>
                        <p className="text-xs text-green-700">Listo para reproducir.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowAudioPreview((prev) => !prev)}
                        className="rounded-full bg-green-600 px-3 py-1 text-xs font-semibold text-white hover:bg-green-500"
                      >
                        {showAudioPreview ? "Ocultar" : "Reproducir"}
                      </button>
                    </div>
                    {showAudioPreview ? (
                      <div className="overflow-hidden rounded-md border border-green-100 bg-white shadow-inner">
                        <audio src={url} controls className="w-full bg-neutral-900" />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {type === "quiz" ? (
                <div className="space-y-4 sm:col-span-2">
                  <div className="space-y-3 rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-800">
                        Preguntas del quiz
                      </p>
                      <button
                        type="button"
                        onClick={() => setQuestions((prev) => [...prev, makeEmptyQuestion()])}
                        className="text-sm font-semibold text-blue-600 hover:text-blue-500"
                      >
                        + Agregar pregunta
                      </button>
                    </div>

                    <div className="space-y-3">
                      {loadingQuiz ? (
                        <p className="text-xs text-slate-500">Cargando preguntas...</p>
                      ) : null}
                      {questions.map((question, idx) => (
                        <div
                          key={question.id}
                          className="space-y-3 rounded-lg border border-slate-200 p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <label className="text-sm font-medium text-slate-800">
                              Pregunta {idx + 1}
                            </label>
                            {questions.length > 1 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setQuestions((prev) =>
                                    prev.filter((q) => q.id !== question.id),
                                  )
                                }
                                className="text-xs font-semibold text-red-500 hover:text-red-400"
                              >
                                Eliminar
                              </button>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-slate-700">
                            <span>Tipo:</span>
                            <select
                              value={question.type}
                              onChange={(e) => {
                                const nextType = e.target.value as "multiple" | "truefalse" | "open";
                                setQuestions((prev) =>
                                  prev.map((q) =>
                                    q.id === question.id
                                      ? nextType === "multiple"
                                      ? {
                                          ...q,
                                          type: "multiple",
                                          options: [
                                            {
                                              id: uuidv4(),
                                              text: "",
                                              isCorrect: true,
                                              feedback: "",
                                              correctFeedback: "",
                                              incorrectFeedback: "",
                                            },
                                            {
                                              id: uuidv4(),
                                              text: "",
                                              isCorrect: false,
                                              feedback: "",
                                              correctFeedback: "",
                                              incorrectFeedback: "",
                                            },
                                          ],
                                          answerText: "",
                                        }
                                      : nextType === "truefalse"
                                      ? {
                                          ...q,
                                          type: "truefalse",
                                          options: [
                                            {
                                              id: uuidv4(),
                                              text: "Verdadero",
                                              isCorrect: true,
                                              feedback: "",
                                              correctFeedback: "",
                                              incorrectFeedback: "",
                                            },
                                            {
                                              id: uuidv4(),
                                              text: "Falso",
                                              isCorrect: false,
                                              feedback: "",
                                              correctFeedback: "",
                                              incorrectFeedback: "",
                                            },
                                          ],
                                          answerText: "",
                                        }
                                      : {
                                          ...q,
                                            type: "open",
                                            options: [],
                                            answerText: "",
                                          }
                                      : q,
                                  ),
                                );
                              }}
                              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                            >
                              <option value="multiple">Opción múltiple</option>
                              <option value="truefalse">Verdadero / Falso</option>
                              <option value="open">Respuesta abierta</option>
                            </select>
                          </div>
                          <input
                            value={question.prompt}
                            onChange={(e) =>
                              setQuestions((prev) =>
                                prev.map((q) =>
                                  q.id === question.id ? { ...q, prompt: e.target.value } : q,
                                ),
                              )
                            }
                            placeholder="Escribe la pregunta"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          {question.type === "multiple" ? (
                            <div className="space-y-2">
                              {question.options.map((opt, optIdx) => (
                                <div
                                  key={opt.id}
                                  className="space-y-2 rounded-lg border border-slate-100 p-2"
                                >
                                  <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-slate-700">
                                    <div className="flex items-center gap-2">
                                      <input
                                        type="radio"
                                        name={`correct-${question.id}`}
                                        checked={opt.isCorrect}
                                        onChange={() =>
                                          setQuestions((prev) =>
                                            prev.map((q) =>
                                              q.id === question.id
                                                ? {
                                                    ...q,
                                                    options: q.options.map((o) => ({
                                                      ...o,
                                                      isCorrect: o.id === opt.id,
                                                    })),
                                                  }
                                                : q,
                                            ),
                                          )
                                        }
                                        className="h-4 w-4 text-blue-600"
                                      />
                                      <span className="text-xs text-slate-500">Correcta</span>
                                    </div>
                                    <input
                                      value={opt.text}
                                      onChange={(e) =>
                                        setQuestions((prev) =>
                                          prev.map((q) =>
                                            q.id === question.id
                                              ? {
                                                  ...q,
                                                  options: q.options.map((o) =>
                                                    o.id === opt.id ? { ...o, text: e.target.value } : o,
                                                  ),
                                                }
                                              : q,
                                          ),
                                        )
                                      }
                                      placeholder={`Opción ${optIdx + 1}`}
                                      className="flex-1 min-w-[180px] rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                  </div>
                                  {!opt.isCorrect ? (
                                    <input
                                      value={opt.feedback ?? ""}
                                      onChange={(e) =>
                                        setQuestions((prev) =>
                                          prev.map((q) =>
                                            q.id === question.id
                                              ? {
                                                  ...q,
                                                  options: q.options.map((o) =>
                                                    o.id === opt.id ? { ...o, feedback: e.target.value } : o,
                                                  ),
                                                }
                                              : q,
                                          ),
                                        )
                                      }
                                      placeholder="Explicación breve (solo si es incorrecta)"
                                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                  ) : null}
                                  {question.options.length > 2 ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setQuestions((prev) =>
                                          prev.map((q) =>
                                            q.id === question.id
                                              ? {
                                                  ...q,
                                                  options: q.options.filter((o) => o.id !== opt.id),
                                                }
                                              : q,
                                          ),
                                        )
                                      }
                                      className="text-xs font-semibold text-red-500 hover:text-red-400"
                                    >
                                      Quitar
                                    </button>
                                  ) : null}
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() =>
                                  setQuestions((prev) =>
                                    prev.map((q) =>
                                      q.id === question.id
                                        ? {
                                            ...q,
                                          options: [
                                              ...q.options,
                                              { id: uuidv4(), text: "", isCorrect: false, feedback: "", correctFeedback: "", incorrectFeedback: "" },
                                            ],
                                          }
                                        : q,
                                    ),
                                  )
                                }
                                className="text-sm font-semibold text-blue-600 hover:text-blue-500"
                              >
                                + Agregar opción
                              </button>
                            </div>
                          ) : question.type === "truefalse" ? (
                            <div className="space-y-2">
                              {["Verdadero", "Falso"].map((label) => (
                                <label key={label} className="flex items-center gap-2 text-sm">
                                  <input
                                    type="radio"
                                    name={`tf-${question.id}`}
                                    checked={question.options.some((o) => o.text === label && o.isCorrect)}
                                    onChange={() =>
                                      setQuestions((prev) =>
                                        prev.map((q) =>
                                          q.id === question.id
                                            ? {
                                                ...q,
                                                options: [
                                                  {
                                                    id: uuidv4(),
                                                    text: "Verdadero",
                                                    isCorrect: label === "Verdadero",
                                                    feedback: q.options.find((o) => o.text === "Verdadero")?.feedback ?? "",
                                                    correctFeedback:
                                                      q.options.find((o) => o.text === "Verdadero")?.correctFeedback ?? "",
                                                    incorrectFeedback:
                                                      q.options.find((o) => o.text === "Verdadero")?.incorrectFeedback ?? "",
                                                  },
                                                  {
                                                    id: uuidv4(),
                                                    text: "Falso",
                                                    isCorrect: label === "Falso",
                                                    feedback: q.options.find((o) => o.text === "Falso")?.feedback ?? "",
                                                    correctFeedback:
                                                      q.options.find((o) => o.text === "Falso")?.correctFeedback ?? "",
                                                    incorrectFeedback:
                                                      q.options.find((o) => o.text === "Falso")?.incorrectFeedback ?? "",
                                                  },
                                                ],
                                              }
                                            : q,
                                        ),
                                      )
                                    }
                                    className="h-4 w-4 text-blue-600"
                                  />
                                  {label}
                                </label>
                              ))}
                              <div className="space-y-2 rounded-lg border border-slate-100 p-3 text-sm">
                                <p className="text-xs font-semibold text-slate-600">
                                  Explicación por opción (opcional)
                                </p>
                                {question.options.map((opt) => (
                                  <div key={opt.id}>
                                    {!opt.isCorrect ? (
                                      <input
                                        value={opt.feedback ?? ""}
                                        onChange={(e) =>
                                          setQuestions((prev) =>
                                            prev.map((q) =>
                                              q.id === question.id
                                                ? {
                                                    ...q,
                                                    options: q.options.map((o) =>
                                                      o.id === opt.id ? { ...o, feedback: e.target.value } : o,
                                                    ),
                                                  }
                                                : q,
                                            ),
                                          )
                                        }
                                        placeholder={`Explicación breve para "${opt.text}"`}
                                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-slate-800">
                                Respuesta esperada
                              </label>
                              <input
                                value={question.answerText ?? ""}
                                onChange={(e) =>
                                  setQuestions((prev) =>
                                    prev.map((q) =>
                                      q.id === question.id ? { ...q, answerText: e.target.value } : q,
                                    ),
                                  )
                                }
                                placeholder="Ej: Escribe la respuesta correcta esperada"
                                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="sm:col-span-2">
                  <label className="text-sm font-medium text-slate-800">
                    Contenido (opcional)
                  </label>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              )}
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
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? "Guardando..." : "Guardar Clase"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  placeholder?: string;
};

function RichTextEditor({ value, onChange, onUploadImage, placeholder }: RichTextEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({}),
      Placeholder.configure({
        placeholder: placeholder || "Escribe la descripción y agrega imágenes (arrastrar/pegar)",
      }),
      Link.configure({
        openOnClick: true,
        protocols: ["http", "https", "mailto"],
      }),
      ImageExtension.configure({
        HTMLAttributes: {
          class: "mt-2 max-h-64 w-auto rounded-lg border border-slate-200 object-contain shadow-sm",
          loading: "lazy",
        },
      }),
    ],
    content: value || "<p></p>",
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    },
  });

  useEffect(() => {
    if (editor && editor.getHTML() !== value) {
      editor.commands.setContent(value || "<p></p>", { emitUpdate: false });
    }
  }, [editor, value]);

  const handleAddLink = () => {
    if (!editor) return;
    const url = window.prompt("Pega el enlace");
    if (!url) return;
    editor.chain().focus().setLink({ href: url, target: "_blank", rel: "noopener noreferrer" }).run();
  };

  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Solo se permiten imágenes");
      return;
    }
    if (!editor) return;
    setUploading(true);
    try {
      const url = await onUploadImage(file);
      editor.chain().focus().setImage({ src: url, alt: file.name }).run();
      toast.success("Imagen agregada");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo subir la imagen");
    } finally {
      setUploading(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs text-slate-700">
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          className={`rounded px-2 py-1 font-semibold transition ${
            editor?.isActive("bold") ? "bg-blue-100 text-blue-700" : "hover:bg-slate-100"
          }`}
        >
          B
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          className={`rounded px-2 py-1 italic transition ${
            editor?.isActive("italic") ? "bg-blue-100 text-blue-700" : "hover:bg-slate-100"
          }`}
        >
          I
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          className={`rounded px-2 py-1 line-through transition ${
            editor?.isActive("strike") ? "bg-blue-100 text-blue-700" : "hover:bg-slate-100"
          }`}
        >
          S
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          className={`rounded px-2 py-1 transition ${
            editor?.isActive("bulletList") ? "bg-blue-100 text-blue-700" : "hover:bg-slate-100"
          }`}
        >
          • Lista
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          className={`rounded px-2 py-1 transition ${
            editor?.isActive("orderedList") ? "bg-blue-100 text-blue-700" : "hover:bg-slate-100"
          }`}
        >
          1. Lista
        </button>
        <button
          type="button"
          onClick={handleAddLink}
          className="rounded px-2 py-1 transition hover:bg-slate-100"
        >
          Link
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 transition hover:bg-slate-100"
          disabled={uploading}
        >
          <span role="img" aria-label="imagen">
            🖼️
          </span>
          {uploading ? "Subiendo..." : "Imagen"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await handleImageFile(file);
          }}
        />
      </div>
      <div className="min-h-[180px] max-h-[320px] overflow-y-auto px-3 py-2">
        <EditorContent editor={editor} className="prose max-w-none text-sm text-slate-900" />
      </div>
    </div>
  );
}
