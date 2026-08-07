"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import {
  Camera,
  CheckCircle2,
  Clock,
  LogIn,
  LogOut,
  MapPin,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";

type FaceApiModule = typeof import("@vladmandic/face-api");

type AttendanceLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

type FaceVerification = {
  status: "verified" | "rejected";
  provider: string;
  confidence: number | null;
  checkedAt: string;
  reason: string | null;
};

type AttendanceRecord = {
  id: string;
  teacherId: string;
  teacherName: string;
  teacherEmail: string | null;
  teacherRole: string;
  status: "open" | "closed";
  checkInAt: string;
  checkOutAt: string | null;
  checkInLocation: AttendanceLocation;
  checkOutLocation: AttendanceLocation | null;
  faceVerification: FaceVerification;
};

const FACE_MODEL_URI = "/face-api-models";

function formatDateTime(value: string | null): string {
  if (!value) return "Pendiente";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(start: string, end: string | null): string {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return "0 min";
  const minutes = Math.round((endMs - startMs) / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes} min`;
  return `${hours} h ${remainingMinutes} min`;
}

function formatLocation(location: AttendanceLocation | null): string {
  if (!location) return "Sin ubicacion";
  const accuracy = location.accuracy !== null ? `, +/- ${Math.round(location.accuracy)} m` : "";
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
}

function mapsUrl(location: AttendanceLocation): string {
  return `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  return "No se pudo completar la operacion";
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  } catch {
    // ignore and use fallback
  }
  return "No se pudo completar la operacion";
}

function captureVideoFrame(video: HTMLVideoElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 720;
  canvas.height = video.videoHeight || 540;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No se pudo preparar la captura");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.74);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function averageFaceDescriptors(descriptors: number[][]): number[] {
  if (descriptors.length === 0) return [];
  const length = descriptors[0].length;
  return Array.from({ length }, (_, index) => {
    const sum = descriptors.reduce((acc, descriptor) => acc + descriptor[index], 0);
    return sum / descriptors.length;
  });
}

export default function TeacherAttendancePage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authReady, setAuthReady] = useState(Boolean(auth.currentUser));
  const [activeRecord, setActiveRecord] = useState<AttendanceRecord | null>(null);
  const [recentRecords, setRecentRecords] = useState<AttendanceRecord[]>([]);
  const [hasFaceProfile, setHasFaceProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [captureDataUrl, setCaptureDataUrl] = useState<string | null>(null);
  const [lastLocation, setLastLocation] = useState<AttendanceLocation | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceApiRef = useRef<FaceApiModule | null>(null);
  const faceModelsPromiseRef = useRef<Promise<FaceApiModule> | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
    setCaptureDataUrl(null);
  }, []);

  const loadFaceModels = useCallback(async (): Promise<FaceApiModule> => {
    if (faceApiRef.current) return faceApiRef.current;
    if (!faceModelsPromiseRef.current) {
      faceModelsPromiseRef.current = import("@vladmandic/face-api").then(async (faceapi) => {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URI),
          faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URI),
          faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URI),
        ]);
        faceApiRef.current = faceapi;
        setModelsReady(true);
        return faceapi;
      });
    }
    return faceModelsPromiseRef.current;
  }, []);

  const fetchAttendance = useCallback(async (user: User) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/teacher-attendance", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as {
        data?: {
          activeRecord?: AttendanceRecord | null;
          recentRecords?: AttendanceRecord[];
          hasFaceProfile?: boolean;
        };
      };
      setActiveRecord(payload.data?.activeRecord ?? null);
      setRecentRecords(payload.data?.recentRecords ?? []);
      setHasFaceProfile(payload.data?.hasFaceProfile === true);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
      if (user) {
        void fetchAttendance(user);
      } else {
        setLoading(false);
      }
    });

    return () => {
      unsub();
      stopCamera();
    };
  }, [fetchAttendance, stopCamera]);

  const openCamera = useCallback(async (): Promise<HTMLVideoElement> => {
    await loadFaceModels();
    let stream = streamRef.current;
    if (!stream || stream.getVideoTracks().every((track) => track.readyState === "ended")) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
    }

    const video = videoRef.current;
    if (!video) {
      throw new Error("No se pudo preparar la vista de camara");
    }
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    await video.play();
    setCameraActive(true);
    setCaptureDataUrl(null);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        return video;
      }
      await sleep(100);
    }

    throw new Error("La camara aun no esta lista");
  }, [loadFaceModels]);

  const startCamera = async () => {
    setErrorMessage(null);
    try {
      await openCamera();
    } catch {
      setErrorMessage("No se pudo acceder a la camara o cargar el modelo facial");
    }
  };

  const extractFaceDescriptor = async (): Promise<number[]> => {
    const video = await openCamera();
    const faceapi = await loadFaceModels();
    const descriptors: number[][] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await faceapi
        .detectSingleFace(
          video,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: 416,
            scoreThreshold: 0.4,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (result) {
        descriptors.push(Array.from(result.descriptor));
        if (descriptors.length >= 3) {
          setCaptureDataUrl(captureVideoFrame(video));
          return averageFaceDescriptors(descriptors);
        }
      }

      await sleep(250);
    }

    if (descriptors.length > 0) {
      setCaptureDataUrl(captureVideoFrame(video));
      return averageFaceDescriptors(descriptors);
    }

    throw new Error("No se detecto un rostro claro. Mira de frente a la camara e intenta de nuevo.");
  };

  const requestLocation = async (): Promise<AttendanceLocation> => {
    if (!navigator.geolocation) {
      throw new Error("Este navegador no permite obtener ubicacion");
    }
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
      });
    });
    const location = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    };
    setLastLocation(location);
    return location;
  };

  const saveFaceProfile = async (user: User, faceDescriptor: number[]) => {
    const token = await user.getIdToken();
    const response = await fetch("/api/teacher-attendance/face-profile", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ faceDescriptor }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    setHasFaceProfile(true);
  };

  const handleEnrollFace = async () => {
    if (!currentUser) return;
    setActionLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const faceDescriptor = await extractFaceDescriptor();
      await saveFaceProfile(currentUser, faceDescriptor);
      setStatusMessage("Perfil facial guardado");
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCheckIn = async () => {
    if (!currentUser) return;
    setActionLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const faceDescriptor = await extractFaceDescriptor();
      if (!hasFaceProfile) {
        await saveFaceProfile(currentUser, faceDescriptor);
      }
      const location = await requestLocation();
      const token = await currentUser.getIdToken();
      const response = await fetch("/api/teacher-attendance", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ faceDescriptor, location }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setStatusMessage(hasFaceProfile ? "Entrada registrada" : "Perfil facial creado y entrada registrada");
      await fetchAttendance(currentUser);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCheckOut = async () => {
    if (!currentUser || !activeRecord) return;
    setActionLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const location = await requestLocation();
      const token = await currentUser.getIdToken();
      const response = await fetch(`/api/teacher-attendance/${activeRecord.id}/checkout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ location }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setStatusMessage("Salida registrada");
      await fetchAttendance(currentUser);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <RoleGate allowedRole={["teacher", "adminTeacher", "superAdminTeacher", "coordinadorPlantel", "director"]}>
      <div className="space-y-6 text-slate-900">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[#9f6e61]">Asistencia</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#551b22]">Registro docente</h1>
            <p className="mt-1 text-sm text-[#754848]">
              Entrada, salida, ubicacion y verificacion facial del profesor.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-2 text-sm font-medium text-[#6e2d2d] shadow-sm transition hover:-translate-y-0.5 hover:border-[#8a1f28] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => currentUser && fetchAttendance(currentUser)}
            disabled={!authReady || loading}
          >
            <RefreshCw size={16} />
            Actualizar
          </button>
        </header>

        {!hasFaceProfile ? (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
            <p>En tu primera entrada guardaremos tu perfil facial automaticamente.</p>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}
        {statusMessage ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {statusMessage}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <section className="creator-card space-y-4 rounded-2xl border p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">Identidad</p>
                <h2 className="text-lg font-semibold text-[#551b22]">Captura facial</h2>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full bg-[#f3e3db] px-3 py-1 text-xs font-semibold text-[#6e2d2d]">
                {hasFaceProfile ? <ShieldCheck size={14} /> : <Camera size={14} />}
                {hasFaceProfile ? "Perfil listo" : modelsReady ? "Modelo listo" : "Camara"}
              </span>
            </div>

            <div className="overflow-hidden rounded-xl border border-[#d9b1a1] bg-[#321717]">
              <video ref={videoRef} className="aspect-video w-full object-cover" playsInline muted />
            </div>

            {captureDataUrl ? (
              <div className="flex items-center gap-3 rounded-xl border border-[#d9b1a1]/70 bg-white/70 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={captureDataUrl}
                  alt="Ultima captura facial"
                  className="h-14 w-20 rounded-lg object-cover"
                />
                <div className="min-w-0 text-sm text-[#754848]">
                  <p className="font-semibold text-[#551b22]">Ultima validacion facial</p>
                  <p>La camara sigue activa para el siguiente registro.</p>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#6e2d2d] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#551b22] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={startCamera}
                disabled={actionLoading || cameraActive}
              >
                <Camera size={16} />
                Activar camara
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-2 text-sm font-semibold text-[#6e2d2d] shadow-sm transition hover:border-[#8a1f28] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={stopCamera}
                disabled={!cameraActive || actionLoading}
              >
                <CheckCircle2 size={16} />
                Cerrar camara
              </button>
            </div>

            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-3 text-sm font-semibold text-[#6e2d2d] shadow-sm transition hover:border-[#8a1f28] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleEnrollFace}
              disabled={!currentUser || !cameraActive || actionLoading}
            >
              <ShieldCheck size={17} />
              {hasFaceProfile ? "Actualizar perfil facial" : "Guardar perfil facial"}
            </button>
          </section>

          <section className="creator-card space-y-4 rounded-2xl border p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">Jornada</p>
                <h2 className="text-lg font-semibold text-[#551b22]">
                  {activeRecord ? "Entrada activa" : "Sin entrada activa"}
                </h2>
              </div>
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                  activeRecord ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                }`}
              >
                <Clock size={14} />
                {activeRecord ? "En curso" : "Disponible"}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-[#d9b1a1]/70 bg-white/70 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[#9f6e61]">Entrada</p>
                <p className="mt-2 text-lg font-semibold text-[#551b22]">
                  {activeRecord ? formatDateTime(activeRecord.checkInAt) : "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-[#d9b1a1]/70 bg-white/70 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[#9f6e61]">Tiempo</p>
                <p className="mt-2 text-lg font-semibold text-[#551b22]">
                  {activeRecord ? formatDuration(activeRecord.checkInAt, activeRecord.checkOutAt) : "0 min"}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-[#d9b1a1]/70 bg-white/70 p-4 text-sm text-[#754848]">
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#6e2d2d]" />
                <div className="min-w-0">
                  <p className="font-semibold text-[#551b22]">Ultima ubicacion</p>
                  <p className="break-words">
                    {lastLocation
                      ? formatLocation(lastLocation)
                      : activeRecord
                        ? formatLocation(activeRecord.checkInLocation)
                        : "Pendiente"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#6e2d2d] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#551b22] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleCheckIn}
                disabled={!currentUser || actionLoading || Boolean(activeRecord)}
              >
                <LogIn size={17} />
                {hasFaceProfile ? "Registrar entrada" : "Registrar primera entrada"}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-3 text-sm font-semibold text-[#6e2d2d] shadow-sm transition hover:border-[#8a1f28] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleCheckOut}
                disabled={!currentUser || actionLoading || !activeRecord}
              >
                <LogOut size={17} />
                Registrar salida
              </button>
            </div>
          </section>
        </div>

        <section className="creator-card overflow-hidden rounded-2xl border">
          <div className="flex items-center justify-between gap-3 border-b border-[#d9b1a1]/60 px-5 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">Historial</p>
              <h2 className="text-lg font-semibold text-[#551b22]">Registros recientes</h2>
            </div>
          </div>

          {loading ? (
            <div className="px-5 py-6 text-sm text-[#754848]">Cargando registros...</div>
          ) : recentRecords.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[#754848]">Aun no hay registros de asistencia.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#d9b1a1]/60 text-left text-sm">
                <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Entrada</th>
                    <th className="px-5 py-3 font-semibold">Salida</th>
                    <th className="px-5 py-3 font-semibold">Duracion</th>
                    <th className="px-5 py-3 font-semibold">Identidad</th>
                    <th className="px-5 py-3 font-semibold">Ubicacion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
                  {recentRecords.map((record) => (
                    <tr key={record.id} className="align-top">
                      <td className="px-5 py-4 text-[#551b22]">{formatDateTime(record.checkInAt)}</td>
                      <td className="px-5 py-4 text-[#754848]">{formatDateTime(record.checkOutAt)}</td>
                      <td className="px-5 py-4 font-medium text-[#551b22]">
                        {formatDuration(record.checkInAt, record.checkOutAt)}
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                          <ShieldCheck size={14} />
                          {record.faceVerification.confidence !== null
                            ? `Validado ${Math.round(record.faceVerification.confidence * 100)}%`
                            : "Verificado"}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-[#754848]">
                        <a
                          href={mapsUrl(record.checkInLocation)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 font-medium text-[#6e2d2d] hover:underline"
                        >
                          <MapPin size={14} />
                          {formatLocation(record.checkInLocation)}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </RoleGate>
  );
}
