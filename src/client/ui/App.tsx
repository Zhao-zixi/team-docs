import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Activity, Archive, ArrowDownToLine, ArrowLeft, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Copy, CornerDownRight, Eye, EyeOff, FileCheck2, FilePlus2, FileText, Folder, FolderPlus, ExternalLink, History, KeyRound, LogOut, Mail, Menu, MessageSquareText, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Shield, Trash2, UserPlus, Users, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { CommentAnchor, Document, DocumentSummary, Grant, Member, Revision, Space, Team, User } from "../../shared/types";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { markdownByteLength } from "../markdownSafety";
import { AgentCredentialsDialog } from "./AgentCredentials";
import { MailSettingsDialog } from "./MailSettingsDialog";
import { ProposalReviewPanel } from "../review/ProposalReviewPanel";
import { SpaceReviewPolicyDialog } from "../review/SpaceReviewPolicyDialog";
import { CollaborativeDraftPanel } from "../collaboration/CollaborativeDraftPanel";
import { DocumentWorkflowSection } from "../workflow/DocumentWorkflowSection";
import { DocumentCommentsSection } from "../comments/DocumentCommentsSection";
import { ExternalRoomManagerSection } from "../rooms/ExternalRoomManagerSection";
import { AccessImpactPreview } from "../permissions/AccessImpactPreview";
import { PermissionHealth } from "../permissions/PermissionHealth";
import type { Visibility } from "../../shared/types";

type Dialog = null | "space" | "document" | "members" | "invitations" | "access" | "history" | "audit" | "password" | "team" | "agentTokens" | "mailSettings" | "proposals" | "reviewPolicy" | "permissionHealth";
type Notice = { kind: "success" | "error" | "info"; text: string };
type AccessRequestTarget = { kind: "space" | "document"; teamId: string; spaceId: string; documentId?: string };
const DOCUMENTS_PAGE_SIZE = 100;
async function fetchAllSpaceDocuments(spaceId: string): Promise<DocumentSummary[]> {
  const documents: DocumentSummary[] = [];
  const ids = new Set<string>();
  const offsets = new Set<number>();
  let offset = 0;
  for (let page = 0; page < 1000; page++) {
    if (offsets.has(offset)) throw new Error("文档列表分页位置重复，无法安全加载完整目录。");
    offsets.add(offset);
    const result = await api.get<{documents:DocumentSummary[];hasMore:boolean;nextOffset:number|null}>(`/spaces/${spaceId}/documents?offset=${offset}&limit=${DOCUMENTS_PAGE_SIZE}`);
    if (!Array.isArray(result.documents) || typeof result.hasMore !== "boolean") throw new Error("文档列表响应不完整，请刷新后重试。");
    for (const document of result.documents) {
      if (!ids.has(document.id)) { ids.add(document.id); documents.push(document); }
    }
    if (!result.hasMore) return documents;
    if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset === null || result.nextOffset <= offset || result.nextOffset !== offset + result.documents.length) throw new Error("文档列表分页游标无效或没有前进，已停止加载以避免漏项和循环。");
    offset = result.nextOffset;
  }
  throw new Error("知识库文档数量超出单次加载上限，请缩小知识库后重试。");
}
type DocumentTreeRow = { document: DocumentSummary; depth: number; missingParent: boolean; invalidChain: boolean };
function buildDocumentTree(documents: DocumentSummary[]): DocumentTreeRow[] {
  const byId = new Map(documents.map(document => [document.id, document]));
  const children = new Map<string, DocumentSummary[]>();
  for (const document of documents) {
    if (!document.parentId || !byId.has(document.parentId)) continue;
    const siblings = children.get(document.parentId) ?? [];
    siblings.push(document);
    children.set(document.parentId, siblings);
  }
  const visited = new Set<string>();
  const rows: DocumentTreeRow[] = [];
  const stack: Array<{document:DocumentSummary;depth:number;missingParent:boolean}> = [];
  const roots = documents.filter(document => document.parentId === null || !byId.has(document.parentId));
  for (let index = roots.length - 1; index >= 0; index--) stack.push({document:roots[index],depth:0,missingParent:roots[index].parentId!==null});
  while (stack.length) {
    const current = stack.pop()!;
    if (visited.has(current.document.id)) continue;
    visited.add(current.document.id);
    rows.push({ ...current, invalidChain:false });
    const descendants = children.get(current.document.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) stack.push({document:descendants[index],depth:current.depth+1,missingParent:false});
  }
  for (const document of documents) {
    if (!visited.has(document.id)) {
      visited.add(document.id);
      rows.push({ document, depth: 0, missingParent: false, invalidChain: true });
    }
  }
  return rows;
}
const labelRole = (role: string) => ({ owner: "所有者", admin: "管理员", editor: "编辑者", viewer: "阅读者" }[role] ?? role);
const date = (value?: string) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
const safeHref = (href?: string) => { if (!href) return undefined; try { const u = new URL(href, location.origin); return ["http:","https:","mailto:"].includes(u.protocol) ? href : undefined; } catch { return undefined; } };
const draftKey = (user: string, doc: string) => `teamshelf:draft:${user}:${doc}`;
const layoutPreferencesKey = "teamshelf:layout:v1";
function readLayoutPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(layoutPreferencesKey) ?? "null");
    if (!value || typeof value !== "object") return { teamSidebarCollapsed: false, documentNavCollapsed: false };
    return {
      teamSidebarCollapsed: typeof value.teamSidebarCollapsed === "boolean" ? value.teamSidebarCollapsed : false,
      documentNavCollapsed: typeof value.documentNavCollapsed === "boolean" ? value.documentNavCollapsed : false,
    };
  } catch {
    return { teamSidebarCollapsed: false, documentNavCollapsed: false };
  }
}

export function App() {
  const [user, setUser] = useState<User | null>(null), [teams, setTeams] = useState<Team[]>([]), [team, setTeam] = useState<Team | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]), [space, setSpace] = useState<Space | null>(null), [docs, setDocs] = useState<DocumentSummary[]>([]), [doc, setDoc] = useState<Document | null>(null);
  const [docsLoadError, setDocsLoadError] = useState("");
  const [draft, setDraft] = useState<Document | null>(null), [authChecked, setAuthChecked] = useState(false), [needsSetup, setNeedsSetup] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null), [notice, setNotice] = useState<Notice | null>(null), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [mobileNav, setMobileNav] = useState(false), [query, setQuery] = useState(""), [searchResults, setSearchResults] = useState<DocumentSummary[] | null>(null);
  const [teamSidebarCollapsed, setTeamSidebarCollapsed] = useState<boolean>(() => readLayoutPreferences().teamSidebarCollapsed);
  const [documentNavCollapsed, setDocumentNavCollapsed] = useState<boolean>(() => readLayoutPreferences().documentNavCollapsed);
  const [mobileDocumentListOpen, setMobileDocumentListOpen] = useState(false);
  const [newDocumentParent, setNewDocumentParent] = useState<DocumentSummary | null>(null);
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null);
  const [editPreviewOpen, setEditPreviewOpen] = useState(true);
  const [inviteToken, setInviteToken] = useState(new URLSearchParams(location.search).get("invite")), [inviteInfo, setInviteInfo] = useState<{teamName:string;email:string;role:string;expiresAt:string}|null>(null);
  const [members, setMembers] = useState<Member[]>([]), [invitations, setInvitations] = useState<any[]>([]), [revisions, setRevisions] = useState<Revision[]>([]), [audit, setAudit] = useState<any[]>([]), [access, setAccess] = useState<{visibility:string;grants:Grant[]}|null>(null);
  const [modalBusy, setModalBusy] = useState(false), [formError, setFormError] = useState(""), [editTarget, setEditTarget] = useState<"space"|"document"|"team">("document"), [conflict,setConflict] = useState(false), [richInvalid,setRichInvalid] = useState(false);
  const [accessRequestTarget,setAccessRequestTarget]=useState<AccessRequestTarget|null>(null);
  const [collabOpen,setCollabOpen]=useState(false);
  const [roomManagerOpen,setRoomManagerOpen]=useState(false);
  const [commentsOpen,setCommentsOpen]=useState(false);
  const [selectedCommentText,setSelectedCommentText]=useState<{quote:string;anchor:CommentAnchor}|null>(null);

  const dirty = (!!doc && !!draft && (doc.title !== draft.title || doc.body !== draft.body)) || richInvalid;
  const docRequestGeneration = useRef(0);
  const docsRequestGeneration = useRef(0);
  const dialogRequestGeneration = useRef(0);
  const currentIdentity = useRef({userId:user?.id??null,teamId:team?.id??null,spaceId:space?.id??null,docId:doc?.id??null});
  currentIdentity.current = {userId:user?.id??null,teamId:team?.id??null,spaceId:space?.id??null,docId:doc?.id??null};
  useEffect(()=>{const target=accessRequestTarget;if(!target)return;const current=target.teamId===currentIdentity.current.teamId&&target.spaceId===currentIdentity.current.spaceId&&(target.kind==="space"||target.documentId===currentIdentity.current.docId);if(!current){dialogRequestGeneration.current++;setAccess(null);setAccessRequestTarget(null);setDialog(null);}},[team?.id,space?.id,doc?.id]);
  const admin = team?.role === "owner" || team?.role === "admin";
  useEffect(()=>{setRoomManagerOpen(false);},[team?.id]);

  const fail = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : "操作失败，请稍后重试。";
    setNotice({ kind: "error", text: message });
    if (error instanceof ApiError && (error.status === 401 || error.status === 404 || error.status === 403)) {
      if (error.status === 401) { docRequestGeneration.current++; if (user) clearUserDrafts(user.id); setRichInvalid(false); setUser(null); setDoc(null); setDraft(null); }
      else { docRequestGeneration.current++; if(user&&currentIdentity.current.docId)sessionStorage.removeItem(draftKey(user.id,currentIdentity.current.docId)); setRichInvalid(false); setDoc(null); setDraft(null); setNotice({ kind: "error", text: "访问权限或文档状态已变化，当前正文已清除。请刷新列表后重试。" }); }
    }
  }, [user]);
  const closeCollabForAccessLoss = useCallback(() => setCollabOpen(false), []);
  const clearUserDrafts = (id:string) => { for (let i=sessionStorage.length-1;i>=0;i--) { const key=sessionStorage.key(i); if (key?.startsWith(`teamshelf:draft:${id}:`)) sessionStorage.removeItem(key); } };

  useEffect(() => { let alive=true; Promise.all([api.get<{needsSetup:boolean}>("/setup"), api.get<{user:User;teams:Team[]}>("/auth/me").catch(()=>null)]).then(([s,me])=>{ if(!alive)return;setNeedsSetup(s.needsSetup);if(me){setUser(me.user);setTeams(me.teams); const target=new URLSearchParams(location.search).get("team");setTeam(me.teams.find(t=>t.id===target)??me.teams[0]??null);} }).catch(fail).finally(()=>alive&&setAuthChecked(true)); return()=>{alive=false;}; }, []);
  useEffect(() => { if(!inviteToken)return; api.get<typeof inviteInfo>(`/invitations/${encodeURIComponent(inviteToken)}`).then(i=>setInviteInfo(i as any)).catch(fail); }, [inviteToken]);
  useEffect(() => { if(!user||!team)return; const teamId=team.id; setLoading(true); api.get<{spaces:Space[]}>(`/teams/${teamId}/spaces`).then(({spaces:s})=>{if(currentIdentity.current.teamId!==teamId)return;setSpaces(s); const param=new URLSearchParams(location.search).get("space");setSpace(s.find(x=>x.id===param)??s[0]??null);}).catch(fail).finally(()=>{if(currentIdentity.current.teamId===teamId)setLoading(false);}); }, [user,team?.id]);
  useEffect(() => {
    const spaceId = space?.id;
    const userId = user?.id;
    const teamId = team?.id;
    const generation = ++docsRequestGeneration.current;
    if (!spaceId || !userId || !teamId || space?.teamId !== teamId) { setDocs([]); setDocsLoadError(""); return () => { if (docsRequestGeneration.current === generation) docsRequestGeneration.current++; }; }
    setDocs([]); setDocsLoadError("");
    void fetchAllSpaceDocuments(spaceId).then(documents => {
      if (docsRequestGeneration.current === generation && currentIdentity.current.userId === userId && currentIdentity.current.teamId === teamId && currentIdentity.current.spaceId === spaceId && space.teamId === teamId) { setDocs(documents); setDocsLoadError(""); }
    }).catch(error => {
      if (docsRequestGeneration.current === generation && currentIdentity.current.userId === userId && currentIdentity.current.teamId === teamId && currentIdentity.current.spaceId === spaceId && space.teamId === teamId) { setDocsLoadError(error instanceof Error ? error.message : "无法加载完整文档树。"); fail(error); }
    });
    return () => { if (docsRequestGeneration.current === generation) docsRequestGeneration.current++; };
  }, [user?.id, team?.id, space?.id]);
  useEffect(() => { if(!user||!space)return; const id=new URLSearchParams(location.search).get("doc"); if(id){openDocument(id);} }, [user?.id,space?.id]);
  useEffect(() => { if(!draft||!user)return; const key=draftKey(user.id,draft.id); if(dirty)sessionStorage.setItem(key,JSON.stringify({title:draft.title,body:draft.body})); else sessionStorage.removeItem(key); }, [draft,dirty,user?.id]);
  useEffect(() => { try { localStorage.setItem(layoutPreferencesKey,JSON.stringify({teamSidebarCollapsed,documentNavCollapsed})); } catch {} },[teamSidebarCollapsed,documentNavCollapsed]);
  useEffect(() => { const before=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",before);return()=>window.removeEventListener("beforeunload",before); }, [dirty]);

  async function openDocument(id:string, edit=false) { const generation=++docRequestGeneration.current; const identity={userId:user?.id??null,teamId:team?.id??null,spaceId:space?.id??null}; try { const {document:d}=await api.get<{document:Document}>(`/documents/${id}`); if(generation!==docRequestGeneration.current||identity.userId!==currentIdentity.current.userId||identity.teamId!==currentIdentity.current.teamId||identity.spaceId!==currentIdentity.current.spaceId)return; if(d.spaceId!==identity.spaceId)throw new ApiError("not_found","文档不可用。",404); setDoc(d);setEditingDocumentId(edit&&d.canEdit?d.id:null);setEditPreviewOpen(true);setRichInvalid(false);setConflict(false);const saved=user?sessionStorage.getItem(draftKey(user.id,d.id)):null; let next=d;if(saved){try{const parsed=JSON.parse(saved);if(typeof parsed.body==="string")next={...d,title:parsed.title??d.title,body:parsed.body};}catch{sessionStorage.removeItem(draftKey(user!.id,d.id));}}setDraft(next);setSearchResults(null);window.history.replaceState(null,"",`/?team=${team?.id??d.spaceId}&space=${space?.id??d.spaceId}&doc=${d.id}`);setMobileNav(false);setMobileDocumentListOpen(false); } catch(e){if(generation!==docRequestGeneration.current)return;if(user&&e instanceof ApiError&&e.status===404)sessionStorage.removeItem(draftKey(user.id,id));fail(e);} }
  function captureCommentSelection() {
    if (!doc || !draft) return;
    const textarea = window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]');
    const selection = window.getSelection()?.toString().trim() ?? "";
    const quote = textarea && textarea.selectionEnd > textarea.selectionStart ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim() : selection;
    if (!quote) return;
    const start = doc.body.indexOf(quote);
    if (start < 0) { setSelectedCommentText(null); setNotice({kind:"info",text:"当前选区不在已发布版本中；保存正文或通过协作草稿讨论后再评论。"}); return; }
    const before = doc.body.slice(0, start);
    const paragraphs = doc.body.split(/\n\s*\n/);
    let paragraphIndex = 0, offset = 0;
    for (let index = 0; index < paragraphs.length; index++) {
      const found = paragraphs[index].indexOf(quote);
      if (found >= 0) { paragraphIndex = index; offset = found; break; }
    }
    setSelectedCommentText({quote,anchor:{paragraphIndex,startOffset:offset,endOffset:offset+quote.length}});
  }
  function navigateAway(fn:()=>void) { if(dirty&&!window.confirm(richInvalid?"富文本中有无法转换为 Markdown 的内容。离开会丢弃编辑器状态，请先下载富文本草稿或修复内容。仍要离开吗？":"有未保存的修改。确定离开吗？Markdown 草稿会保留在本次会话中。"))return;fn(); }
  function openChildDocumentDialog(parent: DocumentSummary) {
    navigateAway(() => {
      setNewDocumentParent(parent);
      setDialog("document");
    });
  }
  function returnToDocumentView() {
    if (!doc) return;
    if (dirty && !window.confirm(richInvalid ? "富文本编辑器中有无法保存为 Markdown 的内容。返回查看将关闭编辑器并丢弃这些内容；可导出的本地草稿仍会保留。确定返回查看吗？" : "有未保存修改。返回查看会显示已发布版本；本地草稿会保留，可之后继续编辑。确定返回查看吗？")) return;
    setEditingDocumentId(null);
    setRichInvalid(false);
    setConflict(false);
  }
  async function reloadSpaces() { if(!team)return;const {spaces:s}=await api.get<{spaces:Space[]}>(`/teams/${team.id}/spaces`);setSpaces(s); }
  async function reloadDocs() {
    if (!space || !user || !team || space.teamId !== team.id) return;
    const spaceId = space.id, userId = user.id, teamId = team?.id, generation = ++docsRequestGeneration.current;
    setDocsLoadError("");
    try {
      const documents = await fetchAllSpaceDocuments(spaceId);
      if (docsRequestGeneration.current === generation && currentIdentity.current.userId === userId && currentIdentity.current.teamId === teamId && currentIdentity.current.spaceId === spaceId && space.teamId === teamId) { setDocs(documents); setDocsLoadError(""); }
    } catch (error) {
      if (docsRequestGeneration.current === generation && currentIdentity.current.userId === userId && currentIdentity.current.teamId === teamId && currentIdentity.current.spaceId === spaceId) setDocsLoadError(error instanceof Error ? error.message : "无法加载完整文档树。");
      throw error;
    }
  }
  async function saveDocument() {
    if(!draft||richInvalid||!doc)return;
    const generation=docRequestGeneration.current, identity={userId:user?.id??null,teamId:team?.id??null,spaceId:space?.id??null}, targetId=draft.id;
    if(markdownByteLength(draft.body)>512000){setNotice({kind:"error",text:"正文不能超过 500KB。"});return;}
    setSaving(true);
    const stillCurrent=()=>generation===docRequestGeneration.current&&identity.userId===currentIdentity.current.userId&&identity.teamId===currentIdentity.current.teamId&&identity.spaceId===currentIdentity.current.spaceId&&targetId===doc?.id;
    try {
      const {document:d}=await api.patch<{document:Document}>(`/documents/${draft.id}`,{title:draft.title,body:draft.body,version:doc.version});
      if(!stillCurrent())return;setDoc(d);setDraft(d);setConflict(false);setNotice({kind:"success",text:"文档已保存。"});await reloadDocs();
    } catch(e) {
      if(!stillCurrent())return;
      if(e instanceof ApiError&&e.code==="REVIEW_REQUIRED"){
        try{await api.post(`/documents/${draft.id}/proposals`,{kind:"update",baseVersion:doc.version,title:draft.title,body:draft.body});if(!stillCurrent())return;setDraft(doc);setConflict(false);setNotice({kind:"success",text:"更新提案已提交，正式文档将在其他管理员批准后更新。"});}
        catch(proposalError){if(proposalError instanceof ApiError&&proposalError.status===409){setConflict(true);setNotice({kind:"error",text:"提案基线已变化。你的本地草稿仍保留，请下载或重新核对后提交。"});}else fail(proposalError);}
      }else if(e instanceof ApiError&&e.status===409){setConflict(true);setNotice({kind:"error",text:"保存时发现新版本。你的草稿已保留在本次会话中，请下载草稿或加载服务器版本。"});}else fail(e);
    }finally{setSaving(false);}
  }
  async function createDocument(title="未命名文档",body="",parentId?:string) {
    if(!space)return;
    try{const {document:d}=await api.post<{document:Document}>(`/spaces/${space.id}/documents`,{title,body,...(parentId?{parentId}:{})});await reloadDocs();await openDocument(d.id,true);setNotice({kind:"success",text:parentId?"子文档已创建。":"文档已创建。"});setDialog(null);setNewDocumentParent(null);}
    catch(e){if(e instanceof ApiError&&e.code==="REVIEW_REQUIRED"){try{await api.post(`/spaces/${space.id}/proposals`,{kind:"create",title,body,...(parentId?{parentId}:{}),visibility:"inherit",grants:[]});setDialog(null);setNewDocumentParent(null);setNotice({kind:"success",text:parentId?"子文档提案已提交，父文档会在其他管理员批准后出现在文档树中。":"新建提案已提交，批准前不会出现在正式文档列表中。"});}catch(proposalError){fail(proposalError);}}else fail(e);}
  }
  async function createSpace(name:string,description:string,visibility:string) { if(!team)return;const {space:s}=await api.post<{space:Space}>(`/teams/${team.id}/spaces`,{name,description,visibility});await reloadSpaces();setSpace(s);setNewDocumentParent(null);setDialog(null);setNotice({kind:"success",text:"知识库已创建。"}); }
  async function removeDocument() {
    if(!doc)return;
    const childCount=docs.filter(candidate=>candidate.parentId===doc.id).length;
    if(childCount){setNotice({kind:"error",text:`此文档包含 ${childCount} 个子文档，不能删除。请先处理子文档。`});return;}
    if(!window.confirm(dirty?"文档有未保存修改，删除会丢失此草稿。若空间启用审阅，将提交删除提案，批准前文档仍保留。继续？":"若空间启用审阅，将提交删除提案，批准前文档仍保留；否则会直接删除。继续？"))return;
    try{await api.delete(`/documents/${doc.id}`);if(user)sessionStorage.removeItem(draftKey(user.id,doc.id));setRichInvalid(false);setDoc(null);setDraft(null);history.replaceState(null,"",`/?team=${team?.id}&space=${space?.id}`);await reloadDocs();setNotice({kind:"success",text:"文档已删除。"});}
    catch(e){if(e instanceof ApiError&&e.code==="REVIEW_REQUIRED"){try{await api.post(`/documents/${doc.id}/proposals`,{kind:"delete",baseVersion:doc.version});setNotice({kind:"success",text:"删除提案已提交，批准前正式文档保持不变。"});}catch(proposalError){fail(proposalError);}}else fail(e);}
  }
  async function search(text:string) { setQuery(text);if(!team)return;if(!text.trim()){setSearchResults(null);return;}try{const {documents}=await api.get<{documents:DocumentSummary[]}>(`/teams/${team.id}/search?q=${encodeURIComponent(text)}`);setSearchResults(documents);}catch(e){fail(e);} }
  async function loadDialog(kind:Dialog,targetKind?:"space"|"document") {
    const generation=++dialogRequestGeneration.current;
    const accessKind=targetKind??(editTarget==="space"?"space":"document");
    const target:AccessRequestTarget|null=kind==="access"&&team&&space&&(accessKind==="space"||doc)?{kind:accessKind,teamId:team.id,spaceId:space.id,...(accessKind==="document"&&doc?{documentId:doc.id}:{})}:null;
    const targetStillCurrent=(candidate:AccessRequestTarget)=>candidate.teamId===currentIdentity.current.teamId&&candidate.spaceId===currentIdentity.current.spaceId&&(candidate.kind==="space"||candidate.documentId===currentIdentity.current.docId);
    setDialog(kind);setFormError("");if(kind==="access"){setAccess(null);setAccessRequestTarget(target);setEditTarget(accessKind);}if(!team)return;
    try {
      if(kind==="members"){const r=await api.get<{members:Member[]}>(`/teams/${team.id}/members`);if(generation!==dialogRequestGeneration.current)return;setMembers(r.members);}
      if(kind==="invitations"){const r=await api.get<{invitations:any[]}>(`/teams/${team.id}/invitations`);if(generation!==dialogRequestGeneration.current)return;setInvitations(r.invitations);}
      if(kind==="history"&&doc){const r=await api.get<{revisions:Revision[]}>(`/documents/${doc.id}/revisions`);if(generation!==dialogRequestGeneration.current||doc.id!==currentIdentity.current.docId)return;setRevisions(r.revisions);}
      if(kind==="audit"){const r=await api.get<{events:any[]}>(`/teams/${team.id}/audit`);if(generation!==dialogRequestGeneration.current)return;setAudit(r.events);}
      if(kind==="access"&&target){const {members:m}=await api.get<{members:Member[]}>(`/teams/${target.teamId}/members`);if(generation!==dialogRequestGeneration.current||!targetStillCurrent(target))return;setMembers(m);const path=target.kind==="space"?`/spaces/${target.spaceId}/access`:`/documents/${target.documentId}/access`;const result=await api.get<{visibility:string;grants:Grant[]}>(path);if(generation!==dialogRequestGeneration.current||!targetStillCurrent(target))return;setAccess(result);}
    } catch(e) { if(generation===dialogRequestGeneration.current)fail(e); }
  }
  async function logout(){if(dirty&&!window.confirm(richInvalid?"富文本草稿尚未安全保存，退出将清除本次会话。请先下载草稿。仍要退出吗？":"有未保存的修改，退出会清除本次会话草稿。仍要退出吗？"))return;docRequestGeneration.current++;try{await api.post("/auth/logout");}catch{}if(user)clearUserDrafts(user.id);setUser(null);setTeams([]);setTeam(null);setSpace(null);setNewDocumentParent(null);setRichInvalid(false);setConflict(false);setDoc(null);setDraft(null);setNotice({kind:"success",text:"已退出登录。"});history.replaceState(null,"","/");}

  const shownDocs=searchResults??docs;
  const parentNames = useMemo(() => new Map(docs.map(document => [document.id, document.title || "未命名文档"])), [docs]);
  const visibleDocumentRows = useMemo(() => searchResults
    ? shownDocs.map(document => ({document, depth:0, missingParent:false, invalidChain:false}))
    : buildDocumentTree(shownDocs), [shownDocs, searchResults]);
  const isEditing = !!doc && doc.canEdit && editingDocumentId === doc.id;

  if(!authChecked)return <div className="loading-screen"><div className="brand-mark">屿</div><span>正在打开知屿…</span></div>;
  if(inviteToken&&!user)return <AuthPage mode="invite" needsSetup={needsSetup} invite={inviteInfo} token={inviteToken} onSuccess={async(data)=>{setUser(data.user);setTeams(data.teams);setTeam(data.teams[0]??null);setInviteToken(null);history.replaceState(null,"","/");}} onNotice={setNotice}/>;
  if(!user)return <AuthPage mode={needsSetup?"setup":"login"} needsSetup={needsSetup} onSuccess={data=>{setUser(data.user);setTeams(data.teams);setTeam(data.teams[0]??null);setNeedsSetup(false);}} onNotice={setNotice}/>;

  return <div className={`app-shell ${mobileNav?"nav-open":""} ${teamSidebarCollapsed?"team-sidebar-collapsed":""} ${documentNavCollapsed?"document-nav-collapsed":""} ${doc&&!mobileDocumentListOpen?"mobile-document-content":""}`}>
    <aside className="sidebar" id="team-sidebar" aria-label="团队导航">
      <div className="brand-row"><div className="brand-mark">屿</div><div className="brand-text"><strong>知屿</strong><span>TeamShelf</span></div><button className="icon-button panel-collapse-toggle sidebar-collapse-toggle" aria-label={teamSidebarCollapsed?"展开团队侧栏":"折叠团队侧栏"} aria-expanded={!teamSidebarCollapsed} aria-controls="team-sidebar-content" onClick={()=>setTeamSidebarCollapsed(value=>!value)}>{teamSidebarCollapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button><button className="icon-button mobile-close" aria-label="关闭导航" onClick={()=>setMobileNav(false)}><X/></button></div>
      <div className="sidebar-content" id="team-sidebar-content">
      <label className="team-select-label">当前团队</label><div className="team-switcher"><select aria-label="切换团队" value={team?.id??""} onChange={e=>{const t=teams.find(x=>x.id===e.target.value);if(t){navigateAway(()=>{docRequestGeneration.current++;setTeam(t);setSpace(null);setDialog(null);setNewDocumentParent(null);setSpaces([]);setDocs([]);setSearchResults(null);setRichInvalid(false);setDoc(null);setDraft(null);});}}}>{teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><ChevronDown size={15}/></div>
      <button className="side-action" onClick={()=>setDialog("team")}><Plus size={16}/>创建团队</button>
      <div className="side-section-head"><span>知识库</span>{admin&&<button className="icon-button small" aria-label="新建知识库" onClick={()=>setDialog("space")}><Plus size={16}/></button>}</div>
      <nav className="space-list">{loading?<div className="skeleton-line"/>:spaces.map(s=><button key={s.id} className={`space-link ${space?.id===s.id?"active":""}`} onClick={()=>navigateAway(()=>{docRequestGeneration.current++;setSpace(s);setDialog(null);setNewDocumentParent(null);setRichInvalid(false);setDoc(null);setDraft(null);setSearchResults(null);})}><Folder size={16}/><span>{s.name}</span>{s.visibility==="restricted"&&<Shield size={13} className="muted-icon"/>}</button>)}{!spaces.length&&!loading&&<div className="empty-side">还没有知识库{admin&&<button onClick={()=>setDialog("space")}>创建一个</button>}</div>}</nav>
      <div className="sidebar-bottom"><button className="space-link" onClick={()=>loadDialog("members")}><Users size={16}/>团队成员</button>{admin&&<button className="space-link" onClick={()=>{dialogRequestGeneration.current++;setDialog("mailSettings");setFormError("");}}><Mail size={16}/>邮箱与邀请</button>}<button className="space-link" onClick={()=>{dialogRequestGeneration.current++;setDialog("agentTokens");setFormError("");}}><KeyRound size={16}/>Agent / MCP</button>{admin&&<button className="space-link" onClick={()=>setRoomManagerOpen(true)}><ExternalLink size={16}/>外部资料室</button>}<button className="space-link" onClick={()=>loadDialog("proposals")}><Check size={16}/>{admin?"提案审阅":"我的提案"}</button>{admin&&<button className="space-link" onClick={()=>loadDialog("audit")}><Activity size={16}/>管理员审计</button>}{admin&&<button className="space-link" onClick={()=>loadDialog("permissionHealth")}><Shield size={16}/>权限体检</button>}<div className="profile"><div className="avatar">{user.name.slice(0,1)}</div><div className="profile-copy"><strong>{user.name}</strong><span>{labelRole(team?.role??"")}</span></div><button className="icon-button" aria-label="账号设置" onClick={()=>setDialog("password")}><Settings2 size={17}/></button><button className="icon-button" aria-label="退出登录" onClick={logout}><LogOut size={17}/></button></div></div>
      </div>
    </aside>
    {mobileNav&&<button className="mobile-scrim" aria-label="关闭菜单" onClick={()=>setMobileNav(false)}/>}
    <main className="main-area"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="打开团队侧栏" aria-expanded={mobileNav} aria-controls="team-sidebar" onClick={()=>setMobileNav(true)}><Menu/></button>{doc&&<button className="icon-button mobile-doc-list-toggle" aria-label={mobileDocumentListOpen?"返回文档正文":"打开文档列表"} aria-expanded={mobileDocumentListOpen} aria-controls="document-navigation" onClick={()=>setMobileDocumentListOpen(value=>!value)}>{mobileDocumentListOpen?<PanelLeftClose size={17}/>:<PanelLeftOpen size={17}/>}</button>}<span className="crumb-muted">{team?.name}</span><ChevronRight size={14}/><span>{space?.name??"知识空间"}</span>{doc&&<><ChevronRight size={14}/><span className="crumb-current">{draft?.title}</span></>}</div><div className="search-wrap"><Search size={17}/><input aria-label="搜索团队文档" placeholder="搜索文档…" value={query} onChange={e=>search(e.target.value)}/><kbd>⌘ K</kbd></div></header>
    <div className="workspace"><section className="doc-nav" id="document-navigation" aria-label="文档列表"><button className="icon-button doc-nav-restore" aria-label="展开文档列表" aria-expanded="false" aria-controls="document-navigation-content" onClick={()=>setDocumentNavCollapsed(false)}><PanelLeftOpen size={17}/></button><div className="doc-nav-content" id="document-navigation-content"><div className="doc-nav-title"><div><span className="eyebrow">知识库</span><h1>{space?.name??"选择知识库"}</h1></div><div className="space-title-actions"><button className="icon-button doc-nav-desktop-toggle" aria-label={documentNavCollapsed?"展开文档列表":"折叠文档列表"} aria-expanded={!documentNavCollapsed} aria-controls="document-navigation-content" onClick={()=>setDocumentNavCollapsed(value=>!value)}>{documentNavCollapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button>{space?.canManage&&<button className="secondary-button icon-action" aria-label="知识库访问权限" onClick={()=>void loadDialog("access","space")}><Shield size={15}/></button>}{space?.canManage&&<button className="secondary-button icon-action" aria-label="知识库审阅规则" onClick={()=>setDialog("reviewPolicy")}><FileCheck2 size={15}/></button>}{space?.canEdit&&<button className="primary-button compact" onClick={()=>{setNewDocumentParent(null);setDialog("document");}}><Plus size={16}/>新建文档</button>}</div></div><p className="space-description">{space?.description||"团队知识在这里安放。"}</p>{searchResults&&<div className="search-caption">搜索结果 · {shownDocs.length} · 按匹配结果平铺显示</div>}<div className="document-list">{visibleDocumentRows.map(({document:d,depth,missingParent,invalidChain})=><div key={d.id} className="document-row"><button data-document-depth={depth} style={{paddingLeft:`${11+depth*16}px`}} className={`document-link ${doc?.id===d.id?"selected":""}`} onClick={()=>navigateAway(()=>openDocument(d.id))}>{depth>0?<CornerDownRight size={16}/>:<FileText size={16}/>}<span className="document-label"><strong>{d.title||"未命名文档"}</strong><small>{date(d.updatedAt)} · {d.updatedByName}</small>{searchResults&&d.parentId&&<small>子文档 · {parentNames.get(d.parentId)??"上级文档"}</small>}{missingParent&&<small className="document-tree-warning">上级文档未出现在当前可见列表中</small>}{invalidChain&&<small className="document-tree-warning">文档层级关系异常</small>}</span></button>{space?.canEdit&&d.canEdit&&<button type="button" className="icon-button document-child-create" aria-label={`在“${d.title||"未命名文档"}”下新建子文档`} title="新建子文档" onClick={()=>openChildDocumentDialog(d)}><FilePlus2 size={15}/></button>}</div>)}{docsLoadError&&<div className="document-tree-load-error" role="alert"><span>{docsLoadError}</span><button className="secondary-button compact" onClick={()=>void reloadDocs().catch(fail)}>重试加载目录</button></div>}{!shownDocs.length&&!docsLoadError&&<div className="empty-docs"><div className="empty-icon"><BookOpen/></div><strong>{searchResults?"没有匹配文档":"这里还没有文档"}</strong><span>{searchResults?"试试其他关键词。":"新建一篇文档，开始整理团队知识。"}</span>{!searchResults&&space?.canEdit&&<button className="text-button" onClick={()=>{setNewDocumentParent(null);setDialog("document");}}>创建第一篇文档</button>}</div>}</div><div className="doc-nav-foot"><span><CircleHelp size={14}/>仅团队成员可访问</span></div></div></section>
        <article className="content-panel">{doc&&draft?<><div className="document-toolbar"><div className="doc-meta"><span className="status-dot"/>{dirty?"本地有未发布草稿":`已保存版本 · v${doc.version}`}<span>更新于 {date(doc.updatedAt)}</span></div><div className="toolbar-actions"><button className="secondary-button" onClick={async()=>{try{await navigator.clipboard.writeText(`${location.origin}/?team=${team?.id}&space=${space?.id}&doc=${doc.id}`);setNotice({kind:"success",text:"文档链接已复制。打开链接仍需登录并具备访问权限。"});}catch{setNotice({kind:"info",text:"复制失败，请从地址栏手动复制链接。"});}}}><Copy size={15}/>复制链接</button><button className="secondary-button" onClick={async()=>{try{const md=await api.get<string>(`/documents/${doc.id}/export`);const blob=new Blob([md],{type:"text/markdown;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`${(doc.title||"document").replace(/[\\/:*?"<>|]/g,"-")}.md`;a.click();URL.revokeObjectURL(a.href);setNotice({kind:"success",text:"Markdown 已导出。"});}catch(e){fail(e);}}}><ArrowDownToLine size={15}/>导出</button><button className="secondary-button" onClick={()=>loadDialog("history")}><History size={15}/></button>{doc.canManage&&<button className="secondary-button icon-action" aria-label="访问权限" onClick={()=>void loadDialog("access","document")}><Shield size={15}/></button>}{doc.canManage&&<button className="secondary-button icon-action danger" aria-label="删除文档" onClick={removeDocument}><Trash2 size={15}/></button>}{!isEditing&&doc.canEdit&&<button className="primary-button" onClick={()=>setEditingDocumentId(doc.id)}>编辑文档</button>}{!isEditing&&doc.canEdit&&space?.canEdit&&<button className="secondary-button child-document-button" aria-label={`在“${doc.title||"未命名文档"}”下新建子文档`} onClick={()=>openChildDocumentDialog(doc)}><FilePlus2 size={15}/>新建子文档</button>}{isEditing&&<><button className="secondary-button" aria-label={editPreviewOpen?"关闭预览":"打开预览"} aria-pressed={editPreviewOpen} onClick={()=>setEditPreviewOpen(value=>!value)}>{editPreviewOpen?<><EyeOff size={15}/>关闭预览</>:<><Eye size={15}/>打开预览</>}</button><button className="secondary-button" aria-label="返回查看" onClick={returnToDocumentView}><ArrowLeft size={15}/>返回查看</button><button className="secondary-button" aria-label="段落评论" onClick={()=>{captureCommentSelection();setCommentsOpen(true);}}><MessageSquareText size={15}/>段落评论</button><button className="secondary-button" aria-label="协作草稿" onClick={()=>setCollabOpen(true)}><Users size={15}/>协作草稿</button>{space?.canEdit&&doc.canEdit&&<button className="secondary-button child-document-button" aria-label={`在“${doc.title||"未命名文档"}”下新建子文档`} onClick={()=>openChildDocumentDialog(doc)}><FilePlus2 size={15}/>新建子文档</button>}<button className="primary-button" disabled={!dirty||saving||richInvalid} onClick={saveDocument}>{saving?"保存中…":"保存"}</button></>}</div></div>{conflict&&isEditing&&<div className="conflict-bar" role="alert"><span>版本已更新，你的草稿仍保留在此设备的本次会话中。</span><button className="secondary-button" onClick={()=>{const blob=new Blob([`# ${draft.title}\n\n${draft.body}`],{type:"text/markdown;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="teamshelf-draft.md";a.click();URL.revokeObjectURL(a.href);}}>下载草稿</button><button className="secondary-button" onClick={async()=>{if(!confirm("加载服务器上的最新版本并丢弃当前草稿？"))return;try{const {document:d}=await api.get<{document:Document}>(`/documents/${doc.id}`);setDoc(d);setDraft(d);setConflict(false);if(user)sessionStorage.removeItem(draftKey(user.id,d.id));}catch(e){fail(e);}}}>加载最新版本</button></div>}{isEditing?<div className={`document-page edit-layout ${editPreviewOpen?"with-edit-preview":"without-edit-preview"}`} onMouseUp={captureCommentSelection} onKeyUp={captureCommentSelection}><section className="edit-column"><input className="title-input" aria-label="文档标题" value={draft.title} maxLength={200} onChange={e=>setDraft({...draft,title:e.target.value})}/><div className="byline"><div className="avatar tiny">{(doc.updatedByName||user.name).slice(0,1)}</div><span>{doc.updatedByName||user.name}</span><span>·</span><span>版本 {doc.version}</span></div><MarkdownEditor value={draft.body} onChange={body=>setDraft({...draft,body})} onValidityChange={setRichInvalid}/></section><aside className="edit-preview" aria-label="编辑预览" hidden={!editPreviewOpen}><div className="preview-head"><span>实时预览</span><span>安全 Markdown 渲染</span></div><SafeMarkdown className="markdown-preview" body={draft.body}/></aside></div>:<div className="document-page published-document"><h1 className="published-title">{doc.title||"未命名文档"}</h1><div className="byline"><div className="avatar tiny">{(doc.updatedByName||user.name).slice(0,1)}</div><span>{doc.updatedByName||user.name}</span><span>·</span><span>版本 {doc.version}</span>{!doc.canEdit&&<span className="read-only-tag">只读</span>}</div>{dirty&&draft&&(doc.canEdit?<div className="inline-note draft-restore-note" role="status">此设备保存有未发布的本地草稿。查看内容仍是已发布版本。<button className="text-button" onClick={()=>setEditingDocumentId(doc.id)}>继续编辑草稿</button></div>:<div className="inline-note draft-restore-note" role="status">此设备存在未发布草稿，但当前账号没有编辑权限；草稿内容不会显示。</div>)}<SafeMarkdown className="markdown-preview" body={doc.body}/></div>}<div className="document-page workflow-page"><DocumentWorkflowSection documentId={doc.id} teamId={team!.id} currentUserId={user.id} canManage={doc.canManage} onError={fail}/></div>{commentsOpen&&<DocumentCommentsSection documentId={doc.id} teamId={team!.id} source={{kind:"published",version:doc.version}} selectedText={selectedCommentText} canWrite={doc.canEdit&&draft.body===doc.body} onError={fail}/>}</>:<div className="welcome-view"><div className="welcome-art"><div className="art-sun"/><div className="art-island"><span/><span/><span/></div><div className="art-water"/></div><span className="eyebrow">TEAM KNOWLEDGE, GENTLY ORGANIZED</span><h2>给团队知识，一个好去处。</h2><p>在知屿，文档有序沉淀，想法自在生长。<br/>从左侧选一篇文档，或开始创建新的知识。</p>{space?.canEdit&&<button className="primary-button" onClick={()=>{setNewDocumentParent(null);setDialog("document");}}><FilePlus2 size={17}/>创建文档</button>}</div>}</article></div></main>
    {notice&&<div className={`toast ${notice.kind}`} role="status"><span>{notice.text}</span><button aria-label="关闭提示" onClick={()=>setNotice(null)}><X size={16}/></button></div>}
    {roomManagerOpen&&team&&<ExternalRoomManagerSection teamId={team.id} onClose={()=>setRoomManagerOpen(false)} onError={fail}/>}
    {dialog&&dialog!=="agentTokens"&&dialog!=="mailSettings"&&dialog!=="reviewPolicy"&&<DialogHost dialog={dialog} close={()=>{dialogRequestGeneration.current++;setAccess(null);setAccessRequestTarget(null);setDialog(null);setNewDocumentParent(null);}} team={team} space={space} doc={doc} newDocumentParent={newDocumentParent} documentTitles={parentNames} admin={!!admin} members={members} invitations={invitations} revisions={revisions} audit={audit} access={access} accessTarget={editTarget} currentUserId={user.id} openDialog={(kind)=>void loadDialog(kind)} onTeamCreated={(created)=>{setTeams(old=>[...old,created]);if(dirty&&!window.confirm(richInvalid?"富文本草稿尚未保存。切换团队会关闭编辑器，是否继续？":"未保存的 Markdown 草稿已保留在本次会话中，切换到新团队？"))return;docRequestGeneration.current++;setTeam(created);setSpace(null);setDialog(null);setNewDocumentParent(null);setSpaces([]);setDocs([]);setSearchResults(null);setRichInvalid(false);setDoc(null);setDraft(null);}} busy={modalBusy} setBusy={setModalBusy} error={formError} setError={setFormError} refresh={loadDialog} createSpace={createSpace} createDocument={createDocument} reload={async()=>{await reloadDocs();await reloadSpaces();}} onNotice={setNotice} onRestore={async revision=>{if(!doc)return;if(dirty&&!window.confirm("有未保存的修改。恢复版本会替换当前草稿，确定继续？"))return;try{const {document:d}=await api.post<{document:Document}>(`/documents/${doc.id}/revisions/${revision.id}/restore`,{version:doc.version});setDoc(d);setDraft(d);setRichInvalid(false);await reloadDocs();setDialog(null);setNotice({kind:"success",text:`已恢复到版本 ${revision.version}，生成了新版本。`});}catch(e){if(e instanceof ApiError&&e.code==="REVIEW_REQUIRED"){try{await api.post(`/documents/${doc.id}/proposals`,{kind:"restore",baseVersion:doc.version,revisionId:revision.id});setNotice({kind:"success",text:"恢复提案已提交，批准后会创建正式新版本。"});setDialog(null);}catch(proposalError){fail(proposalError);}}else fail(e);}}} onSetAccess={async(payload)=>{const target=accessRequestTarget;if(!access||modalBusy||!target)return;const stillCurrent=()=>target.teamId===currentIdentity.current.teamId&&target.spaceId===currentIdentity.current.spaceId&&(target.kind==="space"||target.documentId===currentIdentity.current.docId);if(!stillCurrent())return;const generation=dialogRequestGeneration.current;const path=target.kind==="space"?`/spaces/${target.spaceId}/access`:`/documents/${target.documentId}/access`;await api.put(path,payload);if(generation!==dialogRequestGeneration.current||!stillCurrent())return;dialogRequestGeneration.current++;setAccess(null);setAccessRequestTarget(null);setDialog(null);setNotice({kind:"success",text:"访问权限已更新。"});}} />}
    {dialog==="mailSettings"&&<MailSettingsDialog open user={user} close={()=>{dialogRequestGeneration.current++;setDialog(null);}} onAuthError={fail}/>}
    <AgentCredentialsDialog open={dialog==="agentTokens"} team={team} user={user} spaces={spaces} close={()=>{dialogRequestGeneration.current++;setDialog(null);}} onAuthError={fail}/>
<SpaceReviewPolicyDialog open={dialog==="reviewPolicy"} space={space} close={()=>setDialog(null)} onSaved={enabled=>setNotice({kind:"success",text:enabled?"此知识库已启用提交审阅。":"已关闭提交审阅。"})}/>
    {collabOpen&&doc&&<CollaborativeDraftPanel document={doc} teamId={team!.id} userName={user.name} close={()=>setCollabOpen(false)} onPublished={published=>{setDoc(published);setDraft(published);setRichInvalid(false);void reloadDocs();}} onAccessLost={closeCollabForAccessLoss} onError={fail}/>}
  </div>;
}

type AuthData={user:User;teams:Team[]};
function AuthPage({mode,needsSetup,invite,token,onSuccess,onNotice}:{mode:"login"|"setup"|"invite";needsSetup:boolean;invite?:{teamName:string;email:string;role:string;expiresAt:string}|null;token?:string|null;onSuccess:(data:AuthData)=>void;onNotice:(n:Notice)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[email,setEmail]=useState(invite?.email??""),[name,setName]=useState(""),[password,setPassword]=useState(""),[teamName,setTeamName]=useState(""),[setupToken,setSetupToken]=useState("");
  async function submit(e:React.FormEvent){e.preventDefault();const length=[...password].length;if(length>128){setError("密码不能超过128个Unicode字符。");return;}if(mode==="setup"&&length<8){setError("新密码需要8–128个Unicode字符。");return;}setBusy(true);setError("");try{let data:AuthData;if(mode==="setup"){data=await api.post<AuthData>("/setup",{token:setupToken,name,email,password,teamName});}else if(mode==="invite"){data=await api.post<AuthData>("/invitations/"+encodeURIComponent(token!)+"/accept",{...(name?{name}:{}),password});}else{data=await api.post<AuthData>("/auth/login",{email,password});}onSuccess(data);onNotice({kind:"success",text:mode==="invite"?"已加入团队，欢迎来到知屿。":mode==="setup"?"团队空间已准备好。":"欢迎回来。"});}catch(e){setError(e instanceof Error?e.message:"操作失败，请重试。");}finally{setBusy(false);}}  const title=mode==="setup"?"建立你的知屿":mode==="invite"?"接受团队邀请":"欢迎回来";
  return <div className="auth-shell"><div className="auth-brand"><div className="brand-mark">屿</div><strong>知屿 <small>TeamShelf</small></strong></div><div className="auth-card"><div className="auth-symbol">{mode==="invite"?<UserPlus/>:mode==="setup"?<FolderPlus/>:<BookOpen/>}</div><span className="eyebrow">团队知识空间</span><h1>{title}</h1><p>{mode==="invite"?invite?`你受邀加入「${invite.teamName}」，角色为${labelRole(invite.role)}。`:"正在验证邀请…":mode==="setup"?"创建管理员账号和第一个团队。":"使用你的账号登录团队文档库。"}</p>{mode==="invite"&&invite&&<div className="invite-detail"><span>邀请邮箱</span><strong>{invite.email}</strong><span>有效期至 {date(invite.expiresAt)}</span><small>已有账号使用原密码；新账号请输入姓名和8–128个Unicode字符的新密码，并避免常见弱口令。</small></div>}{error&&<div className="form-error" role="alert">{error}</div>}<form onSubmit={submit} className="stack-form">{mode==="setup"&&<><Field label="初始化口令"><input required type="password" value={setupToken} onChange={e=>setSetupToken(e.target.value)} autoComplete="off"/></Field><Field label="团队名称"><input required value={teamName} onChange={e=>setTeamName(e.target.value)} maxLength={100}/></Field></>}{mode!=="invite"&&<Field label="邮箱"><input required type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"/></Field>}{(mode!=="login")&&<Field label={mode==="invite"?"姓名（已有账号可留空）":"你的姓名"}><input required={mode==="setup"} value={name} onChange={e=>setName(e.target.value)} autoComplete="name"/></Field>}<Field label={mode==="invite"?"密码（已有账号输入原密码；新账号至少8个Unicode字符）":mode==="setup"?"管理员密码（8–128个Unicode字符）":"密码"}><input required type="password" maxLength={256} value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"}/></Field><button className="primary-button full" disabled={busy||mode==="invite"&&!invite}>{busy?"请稍候…":mode==="invite"?"接受邀请并加入":mode==="setup"?"创建团队空间":"登录"}</button></form><div className="auth-foot"><Shield size={14}/>你的文档仅对获授权的团队成员开放</div></div><div className="auth-version">知屿 TeamShelf · 安全、清晰、协作</div></div>;
}

function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="field"><span>{label}</span>{children}</label>}

function SafeMarkdown({body,className}:{body:string;className:string}) { return <div className={className}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({href,children,...props})=>{const link=safeHref(href);return link?<a href={link} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>:<span>{children}</span>;},img:()=>null}}>{body}</ReactMarkdown></div>; }

function DialogHost(p:{dialog:Dialog;close:()=>void;team:Team|null;space:Space|null;doc:Document|null;newDocumentParent:DocumentSummary|null;documentTitles:ReadonlyMap<string,string>;admin:boolean;members:Member[];invitations:any[];revisions:Revision[];audit:any[];access:{visibility:string;grants:Grant[]}|null;accessTarget:"space"|"document"|"team";currentUserId:string;openDialog:(kind:Dialog)=>void;onTeamCreated:(team:Team)=>void;busy:boolean;setBusy:(v:boolean)=>void;error:string;setError:(v:string)=>void;refresh:(d:Dialog)=>Promise<void>;createSpace:(n:string,d:string,v:string)=>Promise<void>;createDocument:(t:string,b:string,parentId?:string)=>Promise<void>;reload:()=>Promise<void>;onNotice:(n:Notice)=>void;onRestore:(r:Revision)=>Promise<void>;onSetAccess:(v:{visibility:string;grants:Grant[]})=>Promise<void>}){
 const [name,setName]=useState(""),[description,setDescription]=useState(""),[visibility,setVisibility]=useState("team"),[body,setBody]=useState(""),[email,setEmail]=useState(""),[role,setRole]=useState("editor"),[token,setToken]=useState(""),[link,setLink]=useState(""),[grants,setGrants]=useState<Grant[]>([]),[newPassword,setNewPassword]=useState(""),[currentPassword,setCurrentPassword]=useState(""),[modalMessage,setModalMessage]=useState("");
 useEffect(()=>{if(p.dialog==="access"&&p.access){setVisibility(p.access.visibility);setGrants(p.access.grants??[]);}},[p.dialog,p.access]);
 useEffect(()=>{if(p.dialog==="team")setModalMessage("");},[p.dialog]);
 async function run(fn:()=>Promise<void>){p.setBusy(true);p.setError("");try{await fn();}catch(e){p.setError(e instanceof Error?e.message:"操作失败，请重试。");}finally{p.setBusy(false);}}
 async function invite(){const result=await api.post<{invitation:any;delivery:"sent"|"failed"}>("/teams/"+p.team!.id+"/invitations/email",{email,role});setLink("");await p.refresh("invitations");setModalMessage(result.delivery==="sent"?"邀请已创建，邮件已发送。":"邀请已创建，但邮件发送失败。请检查 SMTP 设置后重试；如改用手动链接，请先撤销此邀请再重新创建。");} async function createManualInvite(){const r=await api.post<{token:string}>("/teams/"+p.team!.id+"/invitations",{email,role});setLink(location.origin+"/?invite="+encodeURIComponent(r.token));setModalMessage("手动邀请链接已生成；这不会发送邮件，也不代表邮箱已验证。请安全地转发给受邀成员。");} async function copyLink(){try{await navigator.clipboard.writeText(link);setModalMessage("邀请链接已复制。");}catch{setModalMessage("浏览器未提供剪贴板权限，请选择下方文本并复制。");}}
 const [previewSubject,setPreviewSubject]=useState<{userId:string;name:string}|null>(null);
 const membersGrantOptions=p.members.map(m=>({userId:m.id,name:m.name,email:m.email}));
 return <div className="modal-scrim" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)p.close();}}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-head"><div><span className="eyebrow">知屿管理</span><h2 id="modal-title">{{space:"新建知识库",document:"新建文档",members:"团队成员",invitations:"成员邀请",access:"访问权限",history:"文档历史",audit:"管理员审计",password:"修改密码",team:"创建团队",agentTokens:"Agent / MCP 凭据",mailSettings:"邮箱与邀请",proposals:"提案审阅",reviewPolicy:"审阅规则",permissionHealth:"团队权限体检"}[p.dialog!]}</h2></div><button className="icon-button" aria-label="关闭对话框" onClick={p.close}><X/></button></header><div className="modal-body">{p.error&&<div className="form-error" role="alert">{p.error}</div>}{modalMessage&&<div className="inline-note" role="status">{modalMessage}</div>}
 {p.dialog==="space"&&<form className="stack-form" onSubmit={e=>{e.preventDefault();void run(()=>p.createSpace(name,description,visibility));}}><Field label="知识库名称"><input autoFocus required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="简介"><textarea rows={3} maxLength={500} value={description} onChange={e=>setDescription(e.target.value)}/></Field><Field label="默认访问范围"><select value={visibility} onChange={e=>setVisibility(e.target.value)}><option value="team">整个团队</option><option value="restricted">仅指定成员</option></select></Field><div className="inline-note">只有管理员可以管理知识库。非空知识库删除会被服务端拒绝。</div><button className="primary-button full" disabled={p.busy}>{p.busy?"创建中…":"创建知识库"}</button></form>}
 {p.dialog==="document"&&<form className="stack-form" onSubmit={e=>{e.preventDefault();void run(()=>p.createDocument(name||"未命名文档",body,p.newDocumentParent?.id));}}>{p.newDocumentParent&&<div className="inline-note child-parent-note">父文档：{p.newDocumentParent.title||"未命名文档"}。新文档将默认继承空间权限，并继续受所有上级文档权限约束。</div>}<Field label="文档标题"><input autoFocus required maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></Field><div className="import-row"><label className="secondary-button import-button"><ArrowDownToLine size={15}/>导入 .md<input type="file" accept=".md,text/markdown,text/plain" onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>512000){p.setError("Markdown 文件不能超过 500KB。");return;}const reader=new FileReader();reader.onload=()=>setBody(String(reader.result??""));reader.onerror=()=>p.setError("文件读取失败。");reader.readAsText(f);}}/></label><span>纯文本在浏览器本地读取，不会上传文件</span></div><Field label="Markdown 正文"><textarea className="modal-source" value={body} maxLength={512000} onChange={e=>setBody(e.target.value)} placeholder="# 从这里开始…"/></Field><button className="primary-button full" disabled={p.busy}>{p.busy?"创建中…":"创建文档"}</button></form>}
 {p.dialog==="team"&&<form className="stack-form" onSubmit={e=>{e.preventDefault();void run(async()=>{const {team}=await api.post<{team:Team}>("/teams",{name});p.onTeamCreated(team);p.onNotice({kind:"success",text:`团队「${team.name}」已创建并加入切换列表。`});p.close();});}}><Field label="团队名称"><input autoFocus required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></Field><button className="primary-button full" disabled={p.busy}>{p.busy?"创建中…":"创建团队"}</button></form>}
 {p.dialog==="members"&&<><div className="modal-actions"><span className="count-label">{p.members.length} 位成员</span>{p.admin&&<button className="primary-button compact" onClick={()=>p.openDialog("invitations")}><UserPlus size={15}/>管理邀请</button>}</div><div className="member-list">{p.members.map(m=><div className="member-row" key={m.id}><div className="avatar">{m.name.slice(0,1)}</div><div className="member-copy"><strong>{m.name}</strong><span>{m.email}</span></div><span className="role-pill">{labelRole(m.role)}</span>{m.id!==p.currentUserId&&m.role!=="owner"&&(p.team?.role==="owner"||(p.team?.role==="admin"&&m.role!=="admin"))&&<select aria-label={`${m.name}的角色`} value={m.role} onChange={e=>void run(async()=>{await api.patch(`/teams/${p.team!.id}/members/${m.id}`,{role:e.target.value});await p.refresh("members");})}>{p.team?.role==="owner"&&<option value="admin">管理员</option>}<option value="editor">编辑者</option><option value="viewer">阅读者</option></select>}{p.admin&&m.role!=="owner"&&m.id!==p.currentUserId&&<button className="icon-button danger" aria-label={`移除${m.name}`} onClick={()=>void run(async()=>{if(!confirm(`确定移除 ${m.name}？`))return;await api.delete(`/teams/${p.team!.id}/members/${m.id}`);await p.refresh("members");})}><Trash2 size={15}/></button>}</div>)}{!p.members.length&&<EmptyState title="暂无成员" text="邀请团队伙伴加入知识库。"/>}</div><div className="invite-inline"><h3>邀请新成员</h3><div className="invite-form"><input aria-label="受邀邮箱" type="email" placeholder="name@example.com" value={email} onChange={e=>setEmail(e.target.value)}/><select aria-label="邀请角色" value={role} onChange={e=>setRole(e.target.value)}><option value="editor">编辑者</option><option value="viewer">阅读者</option>{p.team?.role==="owner"&&<option value="admin">管理员</option>}</select><button className="primary-button compact" disabled={p.busy||!email} onClick={()=>void run(invite)}><Mail size={15}/>{p.busy?"发送中…":"邮件邀请"}</button><button className="secondary-button compact" disabled={p.busy||!email} onClick={()=>void run(async()=>{await createManualInvite();})}><Copy size={15}/>生成手动链接</button></div>{link&&<div className="invite-link"><input aria-label="邀请链接，可选择复制" readOnly value={link} onFocus={e=>e.currentTarget.select()}/><button className="secondary-button" onClick={copyLink}><Copy size={15}/>复制链接</button></div>}</div></>}
 {p.dialog==="invitations"&&<><div className="member-list">{p.invitations.map(i=><div className="member-row" key={i.id}><div className="member-copy"><strong>{i.email}</strong><span>{labelRole(i.role)} · 到期 {date(i.expiresAt)}</span></div><span className="role-pill">{i.status??"待接受"}</span><span className={"mail-delivery "+(i.deliveryStatus??"not_sent")}>{i.deliveryStatus==="sent"?"邮件已发送":i.deliveryStatus==="failed"?"发送失败":i.deliveryStatus==="sending"?"发送中":"手动链接"}</span>{i.deliveryStatus!=="not_sent"&&i.deliveryStatus!=="sending"&&<button className="secondary-button compact" disabled={p.busy} aria-label={"重新发送邮件给 "+i.email} onClick={()=>void run(async()=>{const result=await api.post<{delivery:"sent"|"failed"}>("/teams/"+p.team!.id+"/invitations/"+i.id+"/send",{});await p.refresh("invitations");setModalMessage(result.delivery==="sent"?"邀请邮件已重新发送，先前链接已失效。":"重发失败；邀请密钥已轮换，先前链接已失效。请检查邮箱设置后重试。");})}>{i.deliveryStatus==="failed"?"重试邮件":"重新发送"}</button>}<button className="icon-button danger" aria-label="撤销邀请" onClick={()=>void run(async()=>{await api.delete(`/teams/${p.team!.id}/invitations/${i.id}`);await p.refresh("invitations");})}><Trash2 size={15}/></button></div>)}{!p.invitations.length&&<EmptyState title="暂无有效邀请" text="创建邀请后会显示在这里。"/>}</div><InviteCreator team={p.team!} onCreated={()=>p.refresh("invitations")}/></>}
 {p.dialog==="access"&&<form className="stack-form" onSubmit={e=>{e.preventDefault();if(membersGrantOptions[0])setPreviewSubject({userId:membersGrantOptions[0].userId,name:membersGrantOptions[0].name});}}><div className="inline-note"><Shield size={15}/>{p.access?"所有者和管理员始终可以访问团队内全部内容。服务端仍会逐次验证权限。":"正在加载当前访问权限，加载完成前无法修改。"}</div><Field label="访问范围"><select value={visibility} disabled={!p.access||p.busy} onChange={e=>setVisibility(e.target.value)}><option value="team">团队成员（沿用空间权限）</option><option value="restricted">仅指定成员</option>{p.doc&&p.accessTarget==="document"&&<option value="inherit">继承知识库权限</option>}</select></Field><div className="grant-list"><strong>指定成员权限</strong>{membersGrantOptions.map(m=>{const selected=grants.find(g=>g.userId===m.userId);return <div className="grant-row" key={m.userId}><label><input type="checkbox" checked={!!selected} disabled={!p.access||p.busy} onChange={e=>setGrants(e.target.checked?[...grants,{userId:m.userId,role:"viewer"}]:grants.filter(g=>g.userId!==m.userId))}/><span>{m.name}<small>{m.email}</small></span></label>{selected&&<select aria-label={`${m.name}的访问权限`} value={selected.role} disabled={!p.access||p.busy} onChange={e=>setGrants(grants.map(g=>g.userId===m.userId?{...g,role:e.target.value as "viewer"|"editor"}:g))}><option value="viewer">阅读</option><option value="editor">编辑</option></select>}<button type="button" className="text-button access-explain-button" disabled={!p.access||p.busy} onClick={()=>setPreviewSubject({userId:m.userId,name:m.name})}>解释与预览</button></div>})}{!membersGrantOptions.length&&<p className="muted-text">成员列表尚未加载，请关闭后重开权限窗口。</p>}</div><p className="muted-text">选择一位成员查看服务端权限解释和拟议变更影响；在预览窗口确认后才会应用整组访问设置。</p></form>}
 {p.dialog==="access"&&previewSubject&&p.team&&p.space&&p.access&&<AccessImpactPreview target={{kind:p.accessTarget as "space"|"document",id:p.accessTarget==="space"?p.space.id:p.doc!.id,teamId:p.team.id,spaceId:p.space.id}} subjectUserId={previewSubject.userId} subjectName={previewSubject.name} visibility={visibility as Visibility} grants={grants} onClose={()=>setPreviewSubject(null)} onApply={()=>{setPreviewSubject(null);p.close();p.onNotice({kind:"success",text:"访问权限已更新。"});void p.reload();}}/>} {p.dialog==="history"&&<div className="revision-list">{p.revisions.map(r=><div className="revision-row" key={r.id}><div><strong>版本 {r.version} · {r.title}</strong><span>{r.authorName} · {date(r.createdAt)}</span></div>{p.admin&&<button className="secondary-button" onClick={()=>void p.onRestore(r)}>恢复此版本</button>}</div>)}{!p.revisions.length&&<EmptyState title="还没有历史版本" text="保存文档后，历史版本会显示在这里。"/>}</div>}
 {p.dialog==="permissionHealth"&&p.team&&<PermissionHealth teamId={p.team.id} canManage={p.admin}/>} {p.dialog==="proposals"&&p.team&&<ProposalReviewPanel teamId={p.team.id} currentUserId={p.currentUserId} canReview={p.admin} documentTitles={p.documentTitles} onChanged={()=>void p.reload()}/>} {p.dialog==="audit"&&<div className="audit-list">{p.audit.map((event,i)=><div className="audit-row" key={event.id??i}><div className="audit-icon"><Activity size={16}/></div><div><strong>{event.summary??event.action??"管理操作"}</strong><span>{event.actorName??event.userName??"团队成员"} · {date(event.createdAt??event.timestamp)}</span></div></div>)}{!p.audit.length&&<EmptyState title="暂无审计事件" text="管理员操作记录会显示在这里。"/>}</div>}
 {p.dialog==="password"&&<form className="stack-form" onSubmit={e=>{e.preventDefault();const passwordLength=[...newPassword].length;if(passwordLength<8||passwordLength>128){p.setError("新密码需要8–128个Unicode字符。");return;}void run(async()=>{await api.post("/auth/password",{currentPassword,newPassword});sessionStorage.clear();p.onNotice({kind:"success",text:"密码已更新，请使用新密码重新登录。"});p.close();location.reload();});}}><div className="inline-note">修改密码后需要重新登录，本次会话中的本地草稿将被清除。</div><Field label="当前密码"><input required type="password" autoComplete="current-password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></Field><Field label="新密码（8–128个Unicode字符）"><input required maxLength={256} type="password" autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></Field><button className="primary-button full" disabled={p.busy}><KeyRound size={15}/>{p.busy?"更新中…":"更新密码"}</button></form>}
 </div></section></div>;
}
function InviteCreator({team,onCreated}:{team:Team;onCreated:()=>Promise<void>}){
 const [email,setEmail]=useState(""),[role,setRole]=useState("editor"),[link,setLink]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
 async function sendEmail(event:React.FormEvent){event.preventDefault();setBusy(true);setError("");setMessage("");try{const result=await api.post<{delivery:"sent"|"failed"}>("/teams/"+team.id+"/invitations/email",{email,role});await onCreated();setMessage(result.delivery==="sent"?"邀请已创建，邮件已发送。":"邀请已创建，但邮件发送失败；可在上方列表中重发。");}catch(reason){setError(reason instanceof Error?reason.message:"邀请邮件发送失败。");}finally{setBusy(false);}}
 async function createLink(){setBusy(true);setError("");setMessage("");try{const result=await api.post<{token:string}>("/teams/"+team.id+"/invitations",{email,role});setLink(location.origin+"/?invite="+encodeURIComponent(result.token));setMessage("手动链接已生成；不会发送邮件，也不代表邮箱已验证。");await onCreated();}catch(reason){setError(reason instanceof Error?reason.message:"无法生成邀请链接。");}finally{setBusy(false);}}
 async function copy(){try{await navigator.clipboard.writeText(link);setMessage("邀请链接已复制。");}catch{setMessage("请选择下方文本并复制。");}}
 return <div className="invite-inline"><h3>邀请新成员</h3><form className="invite-form" onSubmit={sendEmail}><input required aria-label="受邀邮箱" type="email" placeholder="name@example.com" value={email} onChange={e=>setEmail(e.target.value)}/><select aria-label="邀请角色" value={role} onChange={e=>setRole(e.target.value)}><option value="editor">编辑者</option><option value="viewer">阅读者</option>{team.role==="owner"&&<option value="admin">管理员</option>}</select><button className="primary-button compact" disabled={busy||!email}><Mail size={15}/>{busy?"处理中…":"发送邮件邀请"}</button><button type="button" className="secondary-button compact" disabled={busy||!email} onClick={()=>void createLink()}><Copy size={15}/>生成手动链接</button></form>{error&&<div className="form-error" role="alert">{error}</div>}{message&&<div className="inline-note" role="status">{message}</div>}{link&&<div className="invite-link"><input aria-label="手动邀请链接，可选择复制" readOnly value={link} onFocus={e=>e.currentTarget.select()}/><button className="secondary-button" onClick={()=>void copy()}><Copy size={15}/>复制链接</button></div>}</div>
}function EmptyState({title,text}:{title:string;text:string}){return <div className="empty-state"><div className="empty-icon"><Archive/></div><strong>{title}</strong><span>{text}</span></div>}
