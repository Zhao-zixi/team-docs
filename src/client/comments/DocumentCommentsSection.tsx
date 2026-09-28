import { useEffect, useState } from "react";
import type { CommentSource, DocumentComment, Member, CommentAnchor } from "../../shared/types";
import { api } from "../api";
import { DocumentCommentsPanel } from "./DocumentCommentsPanel";

export function DocumentCommentsSection({ documentId, teamId, source, selectedText, canWrite, onError }: {
  documentId: string; teamId: string; source: CommentSource; selectedText: { quote: string; anchor: CommentAnchor } | null; canWrite: boolean; onError(error: unknown): void;
}) {
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = async () => {
    const [result, roster] = await Promise.all([
      api.get<{ comments: DocumentComment[] }>("/documents/" + documentId + "/comments?offset=0&limit=100"),
      api.get<{ members: Member[] }>("/teams/" + teamId + "/members?offset=0&limit=100"),
    ]);
    setComments(result.comments); setMembers(roster.members); setLoaded(true);
  };
  useEffect(() => { let active = true; setLoaded(false); void reload().catch(onError); return () => { active = false; }; }, [documentId, teamId, source.kind, source.kind === "published" ? source.version : 0]);
  const create = async (input: { body: string; quote: string; anchor: CommentAnchor; source: CommentSource; mentionUserIds: string[] }) => {
    let commentSource = input.source;
    if (commentSource.kind === "draft") {
      const latest = await api.get<{ draft: { id: string; state: string; seq: number } }>("/documents/" + documentId + "/draft");
      if (latest.draft.id !== commentSource.draftId || latest.draft.state !== "editing") throw new Error("草稿已送审或发生变化，请在提案中继续讨论。");
      commentSource = { ...commentSource, seq: latest.draft.seq };
    }
    await api.post("/documents/" + documentId + "/comments", { ...input, source: commentSource }); await reload();
  };
  const reply = async (threadId: string, body: string, mentionUserIds: string[]) => {
    await api.post("/comments/" + threadId + "/replies", { body, mentionUserIds }); await reload();
  };
  const resolve = async (threadId: string, resolved: boolean) => {
    await api.patch("/comments/" + threadId, { resolved }); await reload();
  };
  return loaded ? <DocumentCommentsPanel comments={comments} source={source} selectedText={selectedText} mentionableMembers={members} canWrite={canWrite} onCreate={create} onReply={reply} onResolve={resolve}/> : <section className="document-comments" aria-label="文档评论"><div className="agent-loading">正在读取评论…</div></section>;
}
