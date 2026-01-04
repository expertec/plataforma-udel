"use client";

import React, { useEffect, useState } from "react";
import { collection, getDocs, orderBy, query, addDoc, serverTimestamp, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type CommentItem = {
  id: string;
  author: string;
  authorId: string;
  role?: "professor" | "student";
  text: string;
  createdAt: number;
  parentId?: string | null;
};

type Props = {
  courseId: string;
  lessonId: string;
  classId: string;
  className: string;
  isOpen: boolean;
  onClose: () => void;
};

export function CommentsModal({ courseId, lessonId, classId, className, isOpen, onClose }: Props) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(null);
  const userNameCacheRef = React.useRef<Record<string, string>>({});

  const loadComments = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(
        query(
          collection(db, "courses", courseId, "lessons", lessonId, "classes", classId, "comments"),
          orderBy("createdAt", "desc"),
        ),
      );
      const raw = snap.docs.map((d) => {
        const c = d.data();
        return {
          id: d.id,
          author: (c.authorName ?? c.authorId ?? "Usuario").toString(),
          authorId: c.authorId ?? "",
          role: c.role === "professor" ? "professor" : c.role === "student" ? "student" : undefined,
          text: c.text ?? "",
          createdAt: (c.createdAt?.toMillis?.() ?? Date.now()) as number,
          parentId: c.parentId ?? null,
        } as CommentItem;
      });
      const needsName = raw
        .filter(
          (c) =>
            c.authorId &&
            (!c.author || /^profesor$/i.test(c.author) || /^usuario$/i.test(c.author) || /^estudiante$/i.test(c.author)),
        )
        .map((c) => c.authorId);
      if (needsName.length) {
        await Promise.all(
          needsName.map(async (uid) => {
            if (userNameCacheRef.current[uid]) return;
            try {
              const docSnap = await getDoc(doc(db, "users", uid));
              const data = docSnap.data();
              const name = (data?.name ?? data?.displayName ?? data?.email ?? uid) as string;
              if (name) userNameCacheRef.current[uid] = name;
            } catch {
              // ignorar
            }
          }),
        );
      }
      const enriched = raw.map((c) => {
        const cached = c.authorId ? userNameCacheRef.current[c.authorId] : undefined;
        return cached ? { ...c, author: cached } : c;
      });
      setComments(enriched);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const unsub = auth.onAuthStateChanged(async (u) => {
      setCurrentUserId(u?.uid ?? null);
      if (u?.uid) {
        try {
          const userSnap = await getDoc(doc(db, "users", u.uid));
          const data = userSnap.data();
          setCurrentUserName((data?.name ?? data?.displayName ?? u.displayName ?? u.email?.split("@")?.[0] ?? u.uid) as string);
        } catch {
          setCurrentUserName(u.displayName ?? u.email?.split("@")?.[0] ?? u.uid);
        }
      } else {
        setCurrentUserName(null);
      }
    });
    return () => unsub();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, courseId, lessonId, classId]);

  const handleSubmit = async () => {
    const val = text.trim();
    if (!val) return;
    const user = auth.currentUser;
    if (!user) return;
    setText("");
    let displayName = currentUserName?.trim() || user.displayName?.trim();
    const fallbackName = user.email?.split("@")?.[0] ?? user.uid;
    if (!displayName) {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data();
        displayName = (data?.name ?? data?.displayName ?? "") as string;
        if (displayName) {
          userNameCacheRef.current[user.uid] = displayName;
          setCurrentUserName(displayName);
        }
      } catch {
        // ignore
      }
    }
    const payload = {
      text: val,
      authorId: user.uid,
      authorName: displayName || fallbackName || "Profesor",
      role: "professor" as const,
      parentId: replyTo?.id ?? null,
      createdAt: serverTimestamp(),
    };
    await addDoc(
      collection(db, "courses", courseId, "lessons", lessonId, "classes", classId, "comments"),
      payload,
    );
    setReplyTo(null);
    await loadComments();
  };

  const rootComments = comments.filter((c) => !c.parentId);
  const repliesByParent = comments.reduce<Record<string, CommentItem[]>>((acc, c) => {
    if (c.parentId) {
      acc[c.parentId] = acc[c.parentId] ? [...acc[c.parentId], c] : [c];
    }
    return acc;
  }, {});

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Comentarios: {className}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            Cargando comentarios...
          </div>
        ) : rootComments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            Aún no hay comentarios en esta clase.
          </div>
        ) : (
          <div className="space-y-3 max-h-[360px] overflow-auto rounded-lg border border-slate-200 p-3">
            {rootComments.map((c) => (
              <div key={c.id} className="rounded-lg border border-slate-100 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span className="flex items-center gap-2 font-semibold text-slate-800">
                    {c.author}
                    {c.role === "professor" || (currentUserId && c.authorId === currentUserId) ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">
                        Profesor
                      </span>
                    ) : null}
                  </span>
                  <span>{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm text-slate-800 whitespace-pre-wrap">{c.text}</p>
                <button
                  type="button"
                  onClick={() => setReplyTo(c)}
                  className="mt-2 text-xs font-semibold text-blue-600 hover:text-blue-500"
                >
                  Responder
                </button>
                {(repliesByParent[c.id] ?? []).map((r) => (
                  <div key={r.id} className="mt-2 ml-3 rounded-lg border border-slate-100 bg-slate-50 p-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-600">
                      <span className="flex items-center gap-2 font-semibold text-slate-800">
                        {r.author}
                        {r.role === "professor" || (currentUserId && r.authorId === currentUserId) ? (
                          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">
                            Profesor
                          </span>
                        ) : null}
                      </span>
                      <span>{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-slate-800 whitespace-pre-wrap">{r.text}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 space-y-2">
          {replyTo ? (
            <div className="flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
              <span>Respondiendo a {replyTo.author}</span>
              <button type="button" onClick={() => setReplyTo(null)} className="text-blue-600 hover:underline">
                Cancelar
              </button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escribe un comentario"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              rows={2}
            />
            <button
              type="button"
              onClick={handleSubmit}
              className="h-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
            >
              Enviar
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
