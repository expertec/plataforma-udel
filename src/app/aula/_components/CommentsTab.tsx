"use client";

import { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import toast from "react-hot-toast";
import { useAulaData } from "../_lib/AulaDataContext";
import {
  addComment,
  formatRelativeTime,
  hasCommentsPath,
  loadComments,
  type AulaComment,
} from "../_lib/comments";
import type { FeedClass } from "../_lib/types";

function CommentItem({ comment, depth = 0 }: { comment: AulaComment; depth?: number }) {
  return (
    <li className={depth > 0 ? "ml-8 border-l border-[var(--aula-border)] pl-4" : ""}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--aula-accent)]/20 text-xs font-semibold text-[var(--aula-accent-soft)]">
          {comment.author.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--aula-text)]">{comment.author}</span>
            <span className="text-xs text-[var(--aula-text-muted)]">
              {comment.role === "professor" ? "Profesor" : "Estudiante"}
            </span>
          </p>
          <p className="text-xs text-[var(--aula-text-muted)]">
            {formatRelativeTime(comment.createdAt)}
          </p>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--aula-text)]">
            {comment.text}
          </p>
        </div>
      </div>
    </li>
  );
}

export function CommentsTab({
  cls,
  onCountChange,
}: {
  cls: FeedClass;
  onCountChange?: (count: number) => void;
}) {
  const { currentUser, studentName } = useAulaData();
  const [comments, setComments] = useState<AulaComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const available = hasCommentsPath(cls);

  const refresh = useCallback(async () => {
    if (!available) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const loaded = await loadComments(cls);
      setComments(loaded);
      onCountChange?.(loaded.length);
    } catch (err) {
      console.error("No se pudieron cargar los comentarios:", err);
    } finally {
      setLoading(false);
    }
  }, [cls, available, onCountChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || !currentUser?.uid) return;

    setSending(true);
    try {
      await addComment({
        cls,
        text: value,
        authorId: currentUser.uid,
        authorName: currentUser.displayName ?? studentName ?? "Estudiante",
      });
      setText("");
      await refresh();
    } catch (err) {
      console.error("No se pudo guardar el comentario:", err);
      toast.error("No se pudo guardar el comentario");
    } finally {
      setSending(false);
    }
  };

  const roots = comments.filter((comment) => !comment.parentId);
  const repliesOf = (parentId: string) => comments.filter((c) => c.parentId === parentId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {available ? (
        <form onSubmit={handleSubmit} className="flex items-center gap-2 px-4 pb-4">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Escribe tu comentario o aporte"
            className="flex-1 rounded-xl border border-[var(--aula-border)] bg-[var(--aula-bg)] px-3 py-2.5 text-sm text-[var(--aula-text)] outline-none placeholder:text-[var(--aula-text-muted)] focus:border-[var(--aula-accent)]"
          />
          <button
            type="submit"
            disabled={!text.trim() || sending}
            className="rounded-xl bg-[var(--aula-accent)] p-2.5 text-white disabled:opacity-40"
            aria-label="Enviar comentario"
          >
            <Send size={18} />
          </button>
        </form>
      ) : (
        <p className="px-4 pb-4 text-sm text-[var(--aula-text-muted)]">
          Esta clase no admite comentarios.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="text-sm text-[var(--aula-text-muted)]">Cargando comentarios…</p>
        ) : roots.length === 0 ? (
          <p className="text-sm text-[var(--aula-text-muted)]">
            Todavía no hay comentarios. Sé el primero en aportar.
          </p>
        ) : (
          <ul className="space-y-5">
            {roots.map((comment) => (
              <div key={comment.id} className="space-y-4">
                <CommentItem comment={comment} />
                {repliesOf(comment.id).map((reply) => (
                  <CommentItem key={reply.id} comment={reply} depth={1} />
                ))}
              </div>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
