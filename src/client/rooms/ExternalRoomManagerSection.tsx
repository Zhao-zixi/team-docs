import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { DocumentSummary, ExternalRoomSummary, Revision, Space } from "../../shared/types";
import { api, ApiError } from "../api";
import { ExternalRoomCreateInput, ExternalRoomManager, RoomAccessEvent } from "./ExternalRoomManager";

type RoomDocument = DocumentSummary & { publishedVersions: number[] };
export function ExternalRoomManagerSection({ teamId, onClose, onError }: { teamId: string; onClose: () => void; onError(error: unknown): void }) {
  const [rooms, setRooms] = useState<ExternalRoomSummary[]>([]);
  const [documents, setDocuments] = useState<RoomDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void (async () => {
      try {
        const [{ rooms: loadedRooms }, { spaces }] = await Promise.all([
          api.get<{ rooms: ExternalRoomSummary[] }>(`/teams/${teamId}/rooms`),
          api.get<{ spaces: Space[] }>(`/teams/${teamId}/spaces?offset=0&limit=100`),
        ]);
        const listed = await Promise.all(spaces.map(async space => {
          const result = await api.get<{ documents: DocumentSummary[] }>(`/spaces/${space.id}/documents?offset=0&limit=100`);
          return result.documents;
        }));
        const accessible = listed.flat().filter(document => document.canManage);
        const withVersions = await Promise.all(accessible.map(async document => {
          try {
            const { revisions } = await api.get<{ revisions: Revision[] }>(`/documents/${document.id}/revisions?metadataOnly=true&offset=0&limit=100`);
            return { ...document, publishedVersions: revisions.map(revision => revision.version) };
          } catch (cause) {
            if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) return { ...document, publishedVersions: [document.version] };
            throw cause;
          }
        }));
        if (active) { setRooms(loadedRooms); setDocuments(withVersions); }
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : "无法加载资料室。"); onError(cause); }
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [teamId, onError]);

  async function create(input: ExternalRoomCreateInput) {
    const result = await api.post<{ room: ExternalRoomSummary; url: string }>(`/teams/${teamId}/rooms`, input);
    setRooms(current => [result.room, ...current]);
    return { room: result.room, url: result.url };
  }
  async function rotate(roomId: string) {
    const result = await api.post<{ room: ExternalRoomSummary; url: string }>(`/rooms/${roomId}/rotate`, {});
    setRooms(current => current.map(room => room.id === roomId ? result.room : room));
    return { url: result.url };
  }
  async function revoke(roomId: string) {
    await api.delete(`/rooms/${roomId}`);
    setRooms(current => current.map(room => room.id === roomId ? { ...room, revokedAt: new Date().toISOString() } : room));
  }
  async function accessLog(roomId: string) {
    const { events } = await api.get<{ events: RoomAccessEvent[] }>(`/rooms/${roomId}/access-log?offset=0&limit=100`);
    return events;
  }
  return <div className="modal-scrim room-manager-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card room-manager-dialog" role="dialog" aria-modal="true" aria-label="外部资料室管理">
      <header className="modal-head"><div><span className="eyebrow">团队外部分享</span><h2>资料室管理</h2></div><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={18}/></button></header>
      <div className="modal-body">{loading ? <p role="status">正在加载知识库与已发布版本…</p> : error ? <div className="form-error" role="alert">{error}</div> : <ExternalRoomManager teamId={teamId} rooms={rooms} documents={documents} canManage onCreate={create} onRotate={rotate} onRevoke={revoke} onAccessLog={accessLog}/>}</div>
    </section>
  </div>;
}