import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../api";
import type { Team } from "../../shared/types";

interface HealthMember {
  userId: string; name: string; teamRole: Team["role"];
  spacesReadable: number; spacesEditable: number; documentsReadable: number; documentsEditable: number;
}
interface Finding { code: string; resourceKind: "space" | "document"; resourceId: string; userId?: string }
interface HealthPage {
  members: HealthMember[];
  totals: { members: number; spaces: number; documents: number };
  findings: Finding[];
  hasMore: boolean;
  nextOffset: number | null;
}
const roleName = (role: Team["role"]) => ({ owner: "所有者", admin: "管理员", editor: "编辑者", viewer: "阅读者" }[role]);
const findingLabel: Record<string, string> = {
  grant_user_not_team_member: "授权对象已不在此团队中",
  document_grant_blocked_by_space: "文档授权被受限知识库挡住",
};

export function PermissionHealth({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const [page, setPage] = useState<HealthPage | null>(null);
  const [members, setMembers] = useState<HealthMember[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (start: number, append: boolean) => {
    if (!canManage) return;
    setLoading(true); setError("");
    try {
      const result = await api.get<HealthPage>(`/teams/${teamId}/access/health?offset=${start}&limit=50`);
      setPage(result); setMembers(current => append ? [...current, ...result.members] : result.members); setOffset(result.nextOffset ?? start);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? "仅团队所有者和管理员可以查看权限体检。" : cause instanceof ApiError && cause.status === 404 ? "团队状态已变化，请刷新后重试。" : cause instanceof Error ? cause.message : "无法读取权限体检结果。");
    } finally { setLoading(false); }
  }, [teamId, canManage]);
  useEffect(() => { setPage(null); setMembers([]); setOffset(0); void load(0, false); }, [load]);

  return <section className="permission-health" aria-label="团队权限体检">
    <header className="permission-health-head"><div><span className="eyebrow">服务端权限计算</span><h2>团队权限体检</h2><p>列出成员当前可读写数量与数据库中发现的无效授权，不在浏览器推算访问结果。</p></div><button className="secondary-button" disabled={loading} onClick={() => void load(0, false)}><RefreshCw size={14}/>重新检查</button></header>
    {!canManage && <div className="inline-note"><ShieldAlert size={16}/>仅团队所有者和管理员可查看权限体检。</div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {page && <div className="health-summary"><span><b>{page.totals.members}</b> 位成员</span><span><b>{page.totals.spaces}</b> 个知识库</span><span><b>{page.totals.documents}</b> 篇文档</span><span className={page.findings.length ? "has-findings" : ""}><b>{page.findings.length}</b> 条授权问题</span></div>}
    {page?.findings.length ? <section className="health-findings"><h3><AlertTriangle size={15}/>需要核对的授权</h3>{page.findings.map((finding,index)=><article className="health-finding" key={`${finding.code}-${finding.resourceId}-${finding.userId??""}-${index}`}><strong>{findingLabel[finding.code]??finding.code}</strong><small>{finding.resourceKind === "space" ? "知识库" : "文档"} · {finding.resourceId}{finding.userId ? ` · 成员 ${finding.userId}` : ""}</small></article>)}</section> : page && <div className="inline-note"><ShieldAlert size={15}/>没有发现无效授权；计数仍以当前实时访问策略为准。</div>}
    <div className="health-member-list">{members.map(member=><article className="health-member" key={member.userId}><div className="health-member-main"><strong>{member.name}</strong><span>{roleName(member.teamRole)}</span></div><div className="health-counts"><span>知识库 阅读 <b>{member.spacesReadable}</b> · 编辑 <b>{member.spacesEditable}</b></span><span>文档 阅读 <b>{member.documentsReadable}</b> · 编辑 <b>{member.documentsEditable}</b></span></div></article>)}</div>
    {page?.hasMore && <button className="secondary-button" disabled={loading} onClick={() => void load(offset, true)}>{loading ? "加载中…" : "加载更多成员"}</button>}
    {!loading && page && !members.length && <div className="agent-empty"><strong>团队尚无成员数据</strong></div>}
  </section>;
}
