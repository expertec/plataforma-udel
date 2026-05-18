"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import { isAdminTeacherRole, resolveUserRole, type UserRole } from "@/lib/firebase/roles";

type MonitorStatus =
  | "scheduled"
  | "live"
  | "ready"
  | "retrying"
  | "processing"
  | "stalled_processing"
  | "failed"
  | "finalized"
  | "finalized_without_recording";

type LiveClassMonitorItem = {
  classId: string;
  courseId: string;
  lessonId: string;
  title: string;
  courseTitle: string;
  lessonTitle: string;
  docPath: string;
  roomName: string | null;
  sessionStatus: string;
  egressId: string | null;
  recordingStatus: string;
  errorMessage: string | null;
  errorCode: number | null;
  monitorStatus: MonitorStatus;
  teacherActive: boolean;
  recordingAuto: boolean;
  storagePath: string | null;
  backupManifestPath: string | null;
  backupLiveManifestPath: string | null;
  playbackReadyAt: string | null;
  durationSec: number | null;
  retryCount: number;
  maxRetryCount: number;
  lastRetryAt: string | null;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastRelevantAt: string | null;
};

type LiveClassesResponse = {
  success?: boolean;
  data?: {
    items?: LiveClassMonitorItem[];
    counts?: Record<MonitorStatus, number>;
    total?: number;
    fetchedAt?: string;
  };
  error?: string;
};

type LiveClassDiagnostic = {
  classId: string;
  courseId: string;
  lessonId: string;
  roomName: string | null;
  sessionStatus: string;
  recordingStatus: string;
  egressId: string | null;
  errorMessage: string | null;
  errorCode: number | null;
  storagePath: string | null;
  resolvedObjectPath: string | null;
  storageObjectExists: boolean;
  backupManifestPath: string | null;
  resolvedBackupManifestPath: string | null;
  backupManifestExists: boolean;
  activeEgressStatus: string | null;
  activeEgressError: string | null;
  activeEgressErrorCode: number | null;
  recoverable: boolean | null;
  summary: string;
};

type LiveClassDiagnosticResponse = {
  success?: boolean;
  data?: LiveClassDiagnostic;
  error?: string;
};

type LiveRecordingAccess = {
  url: string;
  expiresAt: string;
  objectPath: string;
};

type LiveRecordingAccessResponse = {
  success?: boolean;
  data?: LiveRecordingAccess;
  error?: string;
};

type StorageVideoItem = {
  objectPath: string;
  fileName: string;
  bucketName: string;
  signedUrl: string;
  artifactType: "mp4" | "hls_manifest";
  urlExpiresAt: string;
  updatedAt: string | null;
  sizeBytes: number | null;
  contentType: string;
};

type StorageDisplayItem =
  | {
      kind: "mp4";
      key: string;
      title: string;
      objectPath: string;
      updatedAt: string | null;
      sizeBytes: number | null;
      contentType: string;
      urlExpiresAt: string;
      primaryUrl: string;
      primaryLabel: string;
    }
  | {
      kind: "hls_bundle";
      key: string;
      title: string;
      objectPath: string;
      updatedAt: string | null;
      sizeBytes: number | null;
      contentType: string;
      urlExpiresAt: string;
      primaryUrl: string;
      primaryLabel: string;
      secondaryUrl: string | null;
      secondaryLabel: string | null;
      manifestCount: number;
    };

type LiveRecordingsResponse = {
  success?: boolean;
  data?: {
    items?: StorageVideoItem[];
    prefix?: string;
    bucketName?: string;
    limit?: number;
    nextPageToken?: string | null;
    fetchedAt?: string;
  };
  error?: string;
};

const MONITOR_STATUS_LABELS: Record<MonitorStatus, string> = {
  scheduled: "Programada",
  live: "En vivo",
  ready: "Grabación lista",
  retrying: "Recuperando",
  processing: "Procesando",
  stalled_processing: "Atascada",
  failed: "Falló",
  finalized: "Finalizada",
  finalized_without_recording: "Sin grabación",
};

const MONITOR_STATUS_CLASS: Record<MonitorStatus, string> = {
  scheduled: "bg-slate-100 text-slate-700",
  live: "bg-green-100 text-green-700",
  ready: "bg-emerald-100 text-emerald-700",
  retrying: "bg-indigo-100 text-indigo-700",
  processing: "bg-sky-100 text-sky-700",
  stalled_processing: "bg-orange-100 text-orange-700",
  failed: "bg-rose-100 text-rose-700",
  finalized: "bg-amber-100 text-amber-700",
  finalized_without_recording: "bg-slate-200 text-slate-700",
};

const MONITOR_STATUS_ORDER: MonitorStatus[] = [
  "live",
  "ready",
  "retrying",
  "processing",
  "stalled_processing",
  "failed",
  "finalized",
  "finalized_without_recording",
  "scheduled",
];

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return "N/D";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDuration = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "N/D";
  const totalSeconds = Math.round(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

const formatBytes = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "N/D";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const toSortMs = (value: string | null | undefined) => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const getHlsBundleBasePath = (objectPath: string) =>
  objectPath.replace(/\/(?:index|live)\.m3u8$/i, "");

const getLastPathSegment = (value: string) => value.split("/").pop() ?? value;

const buildStorageDisplayItems = (items: StorageVideoItem[]): StorageDisplayItem[] => {
  const displayItems: StorageDisplayItem[] = [];
  const hlsBundles = new Map<
    string,
    { indexManifest: StorageVideoItem | null; liveManifest: StorageVideoItem | null; sizeBytes: number }
  >();

  items.forEach((item) => {
    if (item.artifactType === "mp4") {
      displayItems.push({
        kind: "mp4",
        key: item.objectPath,
        title: item.fileName,
        objectPath: item.objectPath,
        updatedAt: item.updatedAt,
        sizeBytes: item.sizeBytes,
        contentType: item.contentType,
        urlExpiresAt: item.urlExpiresAt,
        primaryUrl: item.signedUrl,
        primaryLabel: "Abrir video",
      });
      return;
    }

    const bundleKey = getHlsBundleBasePath(item.objectPath);
    const current =
      hlsBundles.get(bundleKey) ??
      {
        indexManifest: null,
        liveManifest: null,
        sizeBytes: 0,
      };

    if (item.fileName.toLowerCase() === "index.m3u8") {
      current.indexManifest = item;
    } else if (item.fileName.toLowerCase() === "live.m3u8") {
      current.liveManifest = item;
    }
    current.sizeBytes += typeof item.sizeBytes === "number" ? item.sizeBytes : 0;
    hlsBundles.set(bundleKey, current);
  });

  hlsBundles.forEach((bundle, bundleKey) => {
    const primary = bundle.indexManifest ?? bundle.liveManifest;
    if (!primary) return;
    const secondary = bundle.indexManifest && bundle.liveManifest
      ? primary.objectPath === bundle.indexManifest.objectPath
        ? bundle.liveManifest
        : bundle.indexManifest
      : null;

    displayItems.push({
      kind: "hls_bundle",
      key: bundleKey,
      title: getLastPathSegment(bundleKey) || "Respaldo HLS",
      objectPath: bundleKey,
      updatedAt:
        toSortMs(bundle.indexManifest?.updatedAt) >= toSortMs(bundle.liveManifest?.updatedAt)
          ? bundle.indexManifest?.updatedAt ?? bundle.liveManifest?.updatedAt ?? null
          : bundle.liveManifest?.updatedAt ?? bundle.indexManifest?.updatedAt ?? null,
      sizeBytes: bundle.sizeBytes || null,
      contentType: "application/vnd.apple.mpegurl",
      urlExpiresAt: primary.urlExpiresAt,
      primaryUrl: primary.signedUrl,
      primaryLabel:
        primary.fileName.toLowerCase() === "index.m3u8"
          ? "Abrir manifest principal"
          : "Abrir manifest live",
      secondaryUrl: secondary?.signedUrl ?? null,
      secondaryLabel: secondary
        ? secondary.fileName.toLowerCase() === "index.m3u8"
          ? "Abrir manifest principal"
          : "Abrir manifest live"
        : null,
      manifestCount: Number(Boolean(bundle.indexManifest)) + Number(Boolean(bundle.liveManifest)),
    });
  });

  return displayItems.sort((a, b) => toSortMs(b.updatedAt) - toSortMs(a.updatedAt));
};

export default function CreatorLiveClassesPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<"monitor" | "storage">("monitor");
  const [monitorLoading, setMonitorLoading] = useState(false);
  const [monitorItems, setMonitorItems] = useState<LiveClassMonitorItem[]>([]);
  const [monitorCounts, setMonitorCounts] = useState<Record<MonitorStatus, number>>({
    scheduled: 0,
    live: 0,
    ready: 0,
    retrying: 0,
    processing: 0,
    stalled_processing: 0,
    failed: 0,
    finalized: 0,
    finalized_without_recording: 0,
  });
  const [monitorFetchedAt, setMonitorFetchedAt] = useState<string | null>(null);
  const [monitorSearch, setMonitorSearch] = useState("");
  const [monitorFilter, setMonitorFilter] = useState<MonitorStatus | "all">("all");
  const [diagnosticLoadingMap, setDiagnosticLoadingMap] = useState<Record<string, boolean>>({});
  const [diagnosticMap, setDiagnosticMap] = useState<Record<string, LiveClassDiagnostic>>({});
  const [recordingAccessLoadingMap, setRecordingAccessLoadingMap] = useState<
    Record<string, boolean>
  >({});
  const [recordingAccessMap, setRecordingAccessMap] = useState<
    Record<string, LiveRecordingAccess>
  >({});
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageItems, setStorageItems] = useState<StorageVideoItem[]>([]);
  const [storagePrefix, setStoragePrefix] = useState("live-recordings");
  const [storageBucket, setStorageBucket] = useState("");
  const [storageFetchedAt, setStorageFetchedAt] = useState<string | null>(null);
  const [storageSearch, setStorageSearch] = useState("");
  const [storageNextPageToken, setStorageNextPageToken] = useState<string | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        if (!cancelled) {
          setUserRole(null);
          setAuthReady(true);
        }
        return;
      }

      try {
        const role = await resolveUserRole(user);
        if (!cancelled) {
          setUserRole(role);
        }
      } catch {
        if (!cancelled) {
          setUserRole(null);
        }
      } finally {
        if (!cancelled) {
          setAuthReady(true);
        }
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const fetchMonitor = useCallback(async () => {
    if (!currentUser) return;
    setMonitorLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch("/api/admin/live-classes", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = (await response.json().catch(() => null)) as LiveClassesResponse | null;
      if (!response.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error || "No se pudo cargar el monitoreo de clases en vivo");
      }

      setMonitorItems(payload.data.items ?? []);
      setMonitorCounts((prev) => ({
        ...prev,
        ...(payload.data?.counts ?? {}),
      }));
      setMonitorFetchedAt(payload.data.fetchedAt ?? new Date().toISOString());
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "No se pudo cargar el monitoreo de clases en vivo",
      );
    } finally {
      setMonitorLoading(false);
    }
  }, [currentUser]);

  const fetchStorage = useCallback(
    async (params: { reset: boolean; cursor?: string | null }) => {
      if (!currentUser) return;
      setStorageLoading(true);
      try {
        const token = await currentUser.getIdToken();
        const searchParams = new URLSearchParams();
        searchParams.set("limit", "12");
        const normalizedSearch = storageSearch.trim();
        if (normalizedSearch) {
          searchParams.set("query", normalizedSearch);
        }
        if (!params.reset && params.cursor) {
          searchParams.set("pageToken", params.cursor);
        }
        const response = await fetch(`/api/admin/live-recordings?${searchParams.toString()}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const payload = (await response.json().catch(() => null)) as
          | LiveRecordingsResponse
          | null;
        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error || "No se pudo cargar el storage de grabaciones");
        }

        const nextItems = payload.data.items ?? [];
        setStorageItems((prev) => {
          const combined = params.reset ? nextItems : [...prev, ...nextItems];
          const deduped = new Map<string, StorageVideoItem>();
          combined.forEach((item) => {
            deduped.set(item.objectPath, item);
          });
          return Array.from(deduped.values());
        });
        setStoragePrefix(payload.data.prefix ?? "live-recordings");
        setStorageBucket(payload.data.bucketName ?? "");
        setStorageFetchedAt(payload.data.fetchedAt ?? new Date().toISOString());
        setStorageNextPageToken(payload.data.nextPageToken ?? null);
        setStorageLoaded(true);
      } catch (error) {
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "No se pudo cargar el storage de grabaciones",
        );
      } finally {
        setStorageLoading(false);
      }
    },
    [currentUser, storageSearch],
  );

  const fetchDiagnostic = useCallback(
    async (item: LiveClassMonitorItem) => {
      if (!currentUser) return;
      setDiagnosticLoadingMap((prev) => ({ ...prev, [item.docPath]: true }));
      try {
        const token = await currentUser.getIdToken();
        const searchParams = new URLSearchParams();
        searchParams.set("courseId", item.courseId);
        searchParams.set("lessonId", item.lessonId);
        const response = await fetch(
          `/api/admin/live-classes/${encodeURIComponent(item.classId)}/diagnostic?${searchParams.toString()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | LiveClassDiagnosticResponse
          | null;
        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error || "No se pudo generar el diagnóstico de la clase");
        }
        setDiagnosticMap((prev) => ({ ...prev, [item.docPath]: payload.data! }));
      } catch (error) {
        console.error(error);
        toast.error(
          error instanceof Error
            ? error.message
            : "No se pudo generar el diagnóstico de la clase",
        );
      } finally {
        setDiagnosticLoadingMap((prev) => ({ ...prev, [item.docPath]: false }));
      }
    },
    [currentUser],
  );

  const fetchRecordingAccess = useCallback(
    async (item: LiveClassMonitorItem) => {
      if (!currentUser) return null;
      setRecordingAccessLoadingMap((prev) => ({ ...prev, [item.docPath]: true }));
      try {
        const token = await currentUser.getIdToken();
        const searchParams = new URLSearchParams();
        searchParams.set("courseId", item.courseId);
        searchParams.set("lessonId", item.lessonId);
        const response = await fetch(
          `/api/live/classes/${encodeURIComponent(item.classId)}/recording?${searchParams.toString()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | LiveRecordingAccessResponse
          | null;
        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error || "No se pudo resolver la grabación");
        }
        setRecordingAccessMap((prev) => ({ ...prev, [item.docPath]: payload.data! }));
        await fetchMonitor();
        toast.success("La grabación quedó disponible en la plataforma.");
        return payload.data;
      } catch (error) {
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "No se pudo resolver la grabación",
        );
        return null;
      } finally {
        setRecordingAccessLoadingMap((prev) => ({ ...prev, [item.docPath]: false }));
      }
    },
    [currentUser, fetchMonitor],
  );

  const copyRecordingLink = useCallback(async (item: LiveClassMonitorItem) => {
    const access = recordingAccessMap[item.docPath];
    if (!access?.url) {
      toast.error("Primero genera el enlace temporal.");
      return;
    }
    try {
      await navigator.clipboard.writeText(access.url);
      toast.success("Enlace temporal copiado.");
    } catch (error) {
      console.error(error);
      toast.error("No se pudo copiar el enlace.");
    }
  }, [recordingAccessMap]);

  useEffect(() => {
    if (!authReady || !currentUser || !isAdminTeacherRole(userRole)) return;
    fetchMonitor();
  }, [authReady, currentUser, userRole, fetchMonitor]);

  useEffect(() => {
    if (activeTab !== "storage" || !currentUser || !isAdminTeacherRole(userRole)) {
      return;
    }
    const timeout = setTimeout(
      () => {
        void fetchStorage({ reset: true });
      },
      storageLoaded ? 250 : 0,
    );
    return () => clearTimeout(timeout);
  }, [activeTab, storageLoaded, currentUser, userRole, storageSearch, fetchStorage]);

  const filteredMonitorItems = useMemo(() => {
    const query = monitorSearch.trim().toLowerCase();
    return monitorItems.filter((item) => {
      if (monitorFilter !== "all" && item.monitorStatus !== monitorFilter) return false;
      if (!query) return true;
      const haystack = [
        item.title,
        item.courseTitle,
        item.lessonTitle,
        item.roomName ?? "",
        item.classId,
        item.storagePath ?? "",
        item.backupManifestPath ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [monitorFilter, monitorItems, monitorSearch]);

  const displayStorageItems = useMemo(
    () => buildStorageDisplayItems(storageItems),
    [storageItems],
  );

  const filteredStorageItems = useMemo(() => {
    const query = storageSearch.trim().toLowerCase();
    if (!query) return displayStorageItems;
    return displayStorageItems.filter((item) => {
      const haystack = `${item.title} ${item.objectPath}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [displayStorageItems, storageSearch]);

  const totalLiveClasses = monitorItems.length;

  return (
    <RoleGate allowedRole={["adminTeacher", "superAdminTeacher"]}>
      <div className="space-y-6">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
                Monitoreo técnico
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-slate-900">Clases en vivo</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">
                Revisa el estado de todas las sesiones live y explora los videos guardados en
                storage bajo <span className="font-semibold text-slate-800">/live-recordings</span>.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fetchMonitor()}
                disabled={monitorLoading || !currentUser}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {monitorLoading ? "Actualizando..." : "Refrescar monitoreo"}
              </button>
              <button
                type="button"
                onClick={() => void fetchStorage({ reset: true })}
                disabled={storageLoading || !currentUser}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                {storageLoading ? "Cargando..." : "Refrescar storage"}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("monitor")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              activeTab === "monitor"
                ? "bg-blue-600 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Monitoreo
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("storage")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              activeTab === "storage"
                ? "bg-blue-600 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Storage
          </button>
        </div>

        {activeTab === "monitor" ? (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm text-slate-500">Total de clases live</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">{totalLiveClasses}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Última lectura: {formatDateTime(monitorFetchedAt)}
                </p>
              </div>
              {MONITOR_STATUS_ORDER.map((status) => (
                <div
                  key={status}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                      MONITOR_STATUS_CLASS[status]
                    }`}
                  >
                    {MONITOR_STATUS_LABELS[status]}
                  </div>
                  <p className="mt-3 text-2xl font-semibold text-slate-900">
                    {monitorCounts[status] ?? 0}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-1 flex-col gap-3 sm:flex-row">
                  <input
                    value={monitorSearch}
                    onChange={(event) => setMonitorSearch(event.target.value)}
                    placeholder="Buscar por clase, curso, lesson, room o storagePath"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400"
                  />
                  <select
                    value={monitorFilter}
                    onChange={(event) =>
                      setMonitorFilter(event.target.value as MonitorStatus | "all")
                    }
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400"
                  >
                    <option value="all">Todos los estados</option>
                    {MONITOR_STATUS_ORDER.map((status) => (
                      <option key={status} value={status}>
                        {MONITOR_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-sm text-slate-500">
                  {filteredMonitorItems.length} clases visibles
                </p>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="px-3 py-3 font-medium">Clase</th>
                      <th className="px-3 py-3 font-medium">Estado</th>
                      <th className="px-3 py-3 font-medium">Sesión</th>
                      <th className="px-3 py-3 font-medium">Grabación</th>
                      <th className="px-3 py-3 font-medium">Diagnóstico</th>
                      <th className="px-3 py-3 font-medium">Última actividad</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredMonitorItems.map((item) => (
                      <tr key={item.docPath} className="align-top">
                        <td className="px-3 py-3">
                          <div className="font-semibold text-slate-900">{item.title}</div>
                          <div className="mt-1 text-slate-600">
                            {item.courseTitle} / {item.lessonTitle}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                            <span>ID clase: {item.classId}</span>
                            <span>Curso: {item.courseId}</span>
                          </div>
                          <Link
                            href={`/creator/cursos/${item.courseId}`}
                            className="mt-2 inline-flex text-xs font-semibold text-blue-600 hover:underline"
                          >
                            Abrir curso
                          </Link>
                        </td>
                        <td className="px-3 py-3">
                          <div
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                              MONITOR_STATUS_CLASS[item.monitorStatus]
                            }`}
                          >
                            {MONITOR_STATUS_LABELS[item.monitorStatus]}
                          </div>
                          <div className="mt-2 text-xs text-slate-500">
                            sessionStatus: {item.sessionStatus}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            recordingStatus: {item.recordingStatus}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            Retries: {item.retryCount}/{item.maxRetryCount}
                          </div>
                          {item.errorMessage ? (
                            <div className="mt-2 rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-700">
                              {item.errorMessage}
                              {typeof item.errorCode === "number" ? ` (code ${item.errorCode})` : ""}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          <div>Room: {item.roomName || "N/D"}</div>
                          <div className="mt-1 break-all">
                            Egress: {item.egressId || "N/D"}
                          </div>
                          <div className="mt-1">
                            Auto: {item.recordingAuto ? "Sí" : "No"} / Teacher active:{" "}
                            {item.teacherActive ? "Sí" : "No"}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          <div>Duración: {formatDuration(item.durationSec)}</div>
                          <div className="mt-1 break-all">
                            {item.storagePath ? item.storagePath : "Sin storagePath"}
                          </div>
                          {item.backupManifestPath ? (
                            <div className="mt-1 break-all text-xs text-slate-500">
                              Backup HLS: {item.backupManifestPath}
                            </div>
                          ) : null}
                          <div className="mt-1 text-xs text-slate-500">
                            Ready at: {formatDateTime(item.playbackReadyAt)}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            Último retry: {formatDateTime(item.lastRetryAt)}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => fetchDiagnostic(item)}
                              disabled={diagnosticLoadingMap[item.docPath] === true}
                              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                            >
                              {diagnosticLoadingMap[item.docPath] ? "Analizando..." : "Diagnóstico"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void fetchRecordingAccess(item)}
                              disabled={recordingAccessLoadingMap[item.docPath] === true}
                              className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                            >
                              {recordingAccessLoadingMap[item.docPath] === true
                                ? "Resolviendo..."
                                : "Forzar disponibilidad"}
                            </button>
                          </div>
                          {recordingAccessMap[item.docPath] ? (
                            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900">
                              <p className="font-semibold">Grabación lista para abrir o compartir.</p>
                              <div className="mt-2 break-all text-emerald-800">
                                {recordingAccessMap[item.docPath].objectPath}
                              </div>
                              <div className="mt-1 text-emerald-700">
                                Enlace temporal vence:{" "}
                                {formatDateTime(recordingAccessMap[item.docPath].expiresAt)}
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <a
                                  href={recordingAccessMap[item.docPath].url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                                >
                                  Abrir video
                                </a>
                                <button
                                  type="button"
                                  onClick={() => void copyRecordingLink(item)}
                                  className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                                >
                                  Copiar enlace temporal
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {diagnosticMap[item.docPath] ? (
                            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5">
                              <p
                                className={`font-semibold ${
                                  diagnosticMap[item.docPath].recoverable === true
                                    ? "text-emerald-700"
                                    : diagnosticMap[item.docPath].recoverable === false
                                      ? "text-rose-700"
                                      : "text-sky-700"
                                }`}
                              >
                                {diagnosticMap[item.docPath].summary}
                              </p>
                              <div className="mt-2 space-y-1 text-slate-600">
                                <div>
                                  Archivo en storage:{" "}
                                  {diagnosticMap[item.docPath].storageObjectExists ? "Sí" : "No"}
                                </div>
                                <div>
                                  Objeto resuelto:{" "}
                                  {diagnosticMap[item.docPath].resolvedObjectPath || "N/D"}
                                </div>
                                <div>
                                  Backup HLS:{" "}
                                  {diagnosticMap[item.docPath].backupManifestExists ? "Sí" : "No"}
                                </div>
                                <div>
                                  Manifest HLS:{" "}
                                  {diagnosticMap[item.docPath].resolvedBackupManifestPath ||
                                    diagnosticMap[item.docPath].backupManifestPath ||
                                    "N/D"}
                                </div>
                                <div>
                                  Estado activo LiveKit:{" "}
                                  {diagnosticMap[item.docPath].activeEgressStatus || "N/D"}
                                </div>
                                <div>
                                  Error LiveKit:{" "}
                                  {diagnosticMap[item.docPath].activeEgressError ||
                                    diagnosticMap[item.docPath].errorMessage ||
                                    "N/D"}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          <div>Inicio: {formatDateTime(item.lastStartedAt)}</div>
                          <div className="mt-1">Fin: {formatDateTime(item.lastEndedAt)}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            Último cambio: {formatDateTime(item.lastRelevantAt)}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!monitorLoading && filteredMonitorItems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">
                          No hay clases en vivo que coincidan con el filtro actual.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm text-slate-500">Bucket</p>
                  <p className="text-lg font-semibold text-slate-900">
                    {storageBucket || "Cargando bucket..."}
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Prefijo: <span className="font-semibold text-slate-700">/{storagePrefix}</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Última lectura: {formatDateTime(storageFetchedAt)}
                  </p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    value={storageSearch}
                    onChange={(event) => setStorageSearch(event.target.value)}
                    placeholder="Buscar por nombre o ruta"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400 sm:w-80"
                  />
                  <button
                    type="button"
                    onClick={() => void fetchStorage({ reset: true })}
                    disabled={storageLoading || !currentUser}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                  >
                    {storageLoading ? "Actualizando..." : "Recargar lista"}
                  </button>
                </div>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {filteredStorageItems.map((item) => (
                <div
                  key={item.key}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  {item.kind === "mp4" ? (
                    <video
                      src={item.primaryUrl}
                      controls
                      preload="metadata"
                      className="h-64 w-full rounded-lg bg-black object-contain"
                    />
                  ) : (
                    <div className="flex h-64 w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
                      <div className="space-y-2 px-6">
                        <div className="inline-flex rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700">
                          Respaldo HLS
                        </div>
                        <p className="text-sm text-slate-600">
                          Respaldo agrupado. Se muestra como una sola grabación aunque contenga
                          `index.m3u8` y `live.m3u8`.
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="mt-4 space-y-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                      <p className="mt-1 break-all text-xs text-slate-500">{item.objectPath}</p>
                    </div>
                    <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
                      <div>Actualizado: {formatDateTime(item.updatedAt)}</div>
                      <div>Tamaño: {formatBytes(item.sizeBytes)}</div>
                      <div>
                        Tipo:{" "}
                        {item.kind === "mp4"
                          ? item.contentType || "video/mp4"
                          : "application/vnd.apple.mpegurl"}
                      </div>
                      <div>URL vence: {formatDateTime(item.urlExpiresAt)}</div>
                      {item.kind === "hls_bundle" ? (
                        <div>Manifests: {item.manifestCount}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <a
                        href={item.primaryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex text-sm font-semibold text-blue-600 hover:underline"
                      >
                        {item.primaryLabel}
                      </a>
                      {item.kind === "hls_bundle" && item.secondaryUrl && item.secondaryLabel ? (
                        <a
                          href={item.secondaryUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex text-sm font-semibold text-slate-600 hover:underline"
                        >
                          {item.secondaryLabel}
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {!storageLoading && filteredStorageItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                No se encontraron videos bajo el filtro actual.
              </div>
            ) : null}

            {storageNextPageToken ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void fetchStorage({ reset: false, cursor: storageNextPageToken })}
                  disabled={storageLoading}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {storageLoading ? "Cargando..." : "Cargar más videos"}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </RoleGate>
  );
}
