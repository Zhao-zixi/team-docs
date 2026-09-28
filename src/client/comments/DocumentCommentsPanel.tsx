import { useMemo, useState } from "react";
import { Check, CornerDownRight, MessageCircle, MoreHorizontal, Send, Undo2 } from "lucide-react";
import type { CommentAnchor, CommentSource, DocumentComment, Member } from "../../shared/types";

export interface CommentCreateInput { body: string; quote: string; anchor: CommentAnchor; source: CommentSource; mentionUserIds: string[] }
export interface DocumentCommentsPanelProps {
  comments: DocumentComment[];
  source: CommentSource;
  selectedText?: { quote: string; anchor: CommentAnchor } | null;
  mentionableMembers: Member[];
  canWrite: boolean;
  onCreate(input: CommentCreateInput): Promise<void>;
  onReply(parentId: string, body: string, mentionUserIds: string[]): Promise<void>;
  onResolve(id: string, resolved: boolean): Promise<void>;
}

function sourceLabel(source: CommentSource) {
  if (source.kind === "published") return `正式版本 v${source.version}`;
  if (source.kind === "draft") return `协作草稿 · 序号 ${source.seq}`;
  return "审阅提案";
}

function MentionInput({ label, disabled, members, onSubmit }: { label: string; disabled?: boolean; members: Member[]; onSubmit(text: string, ids: string[]): Promise<void> }) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const at = text.lastIndexOf("@");
  const query = at >= 0 ? text.slice(at + 1).toLocaleLowerCase() : "";
  const choices = at >= 0 ? members.filter(member => `${member.name} ${member.email}`.toLocaleLowerCase().includes(query)).slice(0, 6) : [];
  const insertMention = (member: Member) => {
    setText(`${text.slice(0, at)}@${member.name} `);
    setMentions(ids => ids.includes(member.id) ? ids : [...ids, member.id]);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!text.trim() || busy || disabled) return;
    setBusy(true);
    try { await onSubmit(text.trim(), mentions); setText(""); setMentions([]); }
    finally { setBusy(false); }
  };
  return <form className="comment-compose" onSubmit={submit}>
    <label className="sr-only" htmlFor={label}>{label}</label>
    <textarea id={label} aria-label={label} value={text} maxLength={4000} rows={2} disabled={disabled || busy} onChange={event => setText(event.currentTarget.value)} placeholder="写下评论，输入 @ 可提醒可编辑的协作者…" />
    {choices.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="可提及的协作者">{choices.map(member => <button type="button" role="option" key={member.id} onClick={() => insertMention(member)}><strong>{member.name}</strong><small>{member.email}</small></button>)}</div>}
    <div className="comment-compose-foot"><span>提及名单只包含当前可协作成员。</span><button className="primary-button compact" disabled={disabled || busy || !text.trim()}><Send size={13}/>{busy ? "发送中…" : "发送"}</button></div>
  </form>;
}

function Thread({ comment, canWrite, members, onReply, onResolve }: { comment: DocumentComment; canWrite: boolean; members: Member[]; onReply(id: string, body: string, ids: string[]): Promise<void>; onResolve(id: string, resolved: boolean): Promise<void> }) {
  const [reply, setReply] = useState(false);
  const replies = useMemo(() => comment.replies ?? [], [comment.replies]);
  return <article className={`comment-thread ${comment.stale ? "stale" : ""}`}>
    <div className="comment-thread-head"><div className="comment-avatar">{comment.authorName.slice(0,1)}</div><div className="comment-author"><strong>{comment.authorName}</strong><span>{new Date(comment.createdAt).toLocaleString("zh-CN")} · {sourceLabel(comment.source)}</span></div>{comment.resolved&&<span className="comment-resolved"><Check size={12}/>已解决</span>}</div>
    {comment.quote && <blockquote className="comment-quote">{comment.quote}{comment.stale&&<small>引用位置已变化，仅供参考，不会自动移动。</small>}</blockquote>}
    <p className="comment-body">{comment.body}</p>
    {comment.mentionUserIds.length > 0 && <div className="comment-mentions">提醒：{comment.mentionUserIds.map(id=>members.find(member=>member.id===id)?.name).filter(Boolean).join("、")||"协作者"}</div>}
    <div className="comment-actions">{canWrite&&<button className="text-button" onClick={()=>setReply(open=>!open)}><CornerDownRight size={13}/>{reply?"收起回复":"回复"}</button>}{canWrite&&<button className="text-button" onClick={()=>void onResolve(comment.id,!comment.resolved)}>{comment.resolved?<Undo2 size={13}/>:<Check size={13}/>} {comment.resolved?"重新打开":"标记解决"}</button>}{replies.length>0&&<span><MessageCircle size={13}/>{replies.length} 条回复</span>}{comment.stale&&<span className="comment-stale-label"><MoreHorizontal size={13}/>引用已过期</span>}</div>
    {reply&&<MentionInput label={`回复 ${comment.authorName}`} members={members} onSubmit={(body,ids)=>onReply(comment.id,body,ids)} />}
    {replies.map(child=><div className="comment-reply" key={child.id}><div className="comment-thread-head"><div className="comment-avatar small">{child.authorName.slice(0,1)}</div><div className="comment-author"><strong>{child.authorName}</strong><span>{new Date(child.createdAt).toLocaleString("zh-CN")}</span></div></div><p className="comment-body">{child.body}</p></div>)}
  </article>;
}

export function DocumentCommentsPanel({ comments, source, selectedText, mentionableMembers, canWrite, onCreate, onReply, onResolve }: DocumentCommentsPanelProps) {
  const [error, setError] = useState("");
  const create = async (body: string, mentionUserIds: string[]) => {
    if (!selectedText) return;
    setError("");
    try { await onCreate({ body, quote: selectedText.quote, anchor: selectedText.anchor, source, mentionUserIds }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "评论发送失败。"); throw cause; }
  };
  return <section className="document-comments" aria-label="文档评论">
    <header className="comments-head"><div><span className="eyebrow">段落讨论</span><h2>评论与提醒</h2></div><span>{comments.length} 个话题</span></header>
    {selectedText?.quote ? <div className="selected-quote"><strong>引用选区</strong><span>{selectedText.quote}</span></div> : <p className="comments-hint">选中文档中的一段文字后，可在这里发起评论。</p>}
    {canWrite&&selectedText?.quote&&<MentionInput label="新建评论" members={mentionableMembers} onSubmit={create}/>}
    {error&&<div className="form-error" role="alert">{error}</div>}
    {!comments.length&&<div className="agent-empty"><MessageCircle size={18}/><strong>还没有评论</strong><span>选中一段正文开始讨论。引用会固定在当前版本，旧引用不会自动移动。</span></div>}
    <div className="comment-list">{comments.map(comment=><Thread key={comment.id} comment={comment} canWrite={canWrite} members={mentionableMembers} onReply={onReply} onResolve={onResolve}/>)}</div>
  </section>;
}
