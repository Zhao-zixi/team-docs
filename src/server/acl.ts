import type { Db } from './db.js';

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type GrantRole = 'viewer' | 'editor';
export type SpaceVisibility = 'team' | 'restricted';
export type DocumentVisibility = 'inherit' | 'restricted';

export interface SpaceAccess {
  teamId: string;
  teamRole: TeamRole;
  visibility: SpaceVisibility;
  grantRole?: GrantRole;
  canRead: boolean;
  canEdit: boolean;
  canManage: boolean;
}

export interface DocumentAccess {
  teamId: string;
  spaceId: string;
  parentId: string | null;
  teamRole: TeamRole;
  visibility: DocumentVisibility;
  version: number;
  canRead: boolean;
  canEdit: boolean;
  canManage: boolean;
}

interface SpaceRow {
  team_id: string;
  role: TeamRole;
  visibility: SpaceVisibility;
  grant_role: GrantRole | null;
}

interface DocumentRow extends SpaceRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  document_visibility: DocumentVisibility;
  document_grant_role: GrantRole | null;
  version: number;
}

function isManager(role: TeamRole): boolean {
  return role === 'owner' || role === 'admin';
}

function roleCanEdit(role: TeamRole): boolean {
  return isManager(role) || role === 'editor';
}

export function getSpaceAccess(db: Db, userId: string, spaceId: string): SpaceAccess | undefined {
  const row = db.prepare(`
    SELECT s.team_id, s.visibility, m.role,
      (SELECT sg.role FROM space_grants sg WHERE sg.space_id=s.id AND sg.user_id=?) AS grant_role
    FROM spaces s JOIN members m ON m.team_id=s.team_id AND m.user_id=?
    WHERE s.id=?
  `).get(userId, userId, spaceId) as SpaceRow | undefined;
  if (!row) return undefined;
  const manager = isManager(row.role);
  const grantRole = row.grant_role ?? undefined;
  const permittedBySpace = row.visibility === 'team' || manager || grantRole !== undefined;
  const canRead = manager || (permittedBySpace && row.role !== undefined);
  const canEdit = manager || (
    canRead && roleCanEdit(row.role) && (row.visibility === 'team' || grantRole === 'editor')
  );
  return {
    teamId: row.team_id,
    teamRole: row.role,
    visibility: row.visibility,
    grantRole,
    canRead,
    canEdit,
    canManage: manager,
  };
}

function documentAccessForRow(row: DocumentRow): Pick<DocumentAccess, 'canRead' | 'canEdit' | 'canManage'> {
  const manager = isManager(row.role);
  const spaceGrant = row.grant_role ?? undefined;
  const docGrant = row.document_grant_role ?? undefined;
  const spaceAllowed = row.visibility === 'team' || manager || spaceGrant !== undefined;
  const spaceCanRead = manager || spaceAllowed;
  const spaceCanEdit = manager || (
    spaceCanRead && roleCanEdit(row.role) && (row.visibility === 'team' || spaceGrant === 'editor')
  );
  const docAllowed = row.document_visibility === 'inherit' || manager || docGrant !== undefined;
  const canRead = manager || (spaceCanRead && docAllowed);
  const canEdit = manager || (
    canRead && spaceCanEdit && (row.document_visibility === 'inherit' || docGrant === 'editor')
  );
  return { canRead, canEdit, canManage: manager };
}

function documentAccessRow(db: Db, userId: string, documentId: string): DocumentRow | undefined {
  return db.prepare(`
    SELECT d.id, d.parent_id, d.space_id, d.visibility AS document_visibility, d.version,
      s.team_id, s.visibility, m.role,
      (SELECT sg.role FROM space_grants sg WHERE sg.space_id=s.id AND sg.user_id=?) AS grant_role,
      (SELECT dg.role FROM document_grants dg WHERE dg.document_id=d.id AND dg.user_id=?) AS document_grant_role
    FROM documents d JOIN spaces s ON s.id=d.space_id
    JOIN members m ON m.team_id=s.team_id AND m.user_id=?
    WHERE d.id=?
  `).get(userId, userId, userId, documentId) as DocumentRow | undefined;
}

export function getDocumentAccess(db: Db, userId: string, documentId: string): DocumentAccess | undefined {
  const row = documentAccessRow(db, userId, documentId);
  if (!row) return undefined;
  const visited = new Set<string>();
  let current: DocumentRow | undefined = row;
  let canRead = true;
  let canEdit = true;
  let canManage = true;
  while (current) {
    if (visited.has(current.id) || current.space_id !== row.space_id) return undefined;
    visited.add(current.id);
    const direct = documentAccessForRow(current);
    canRead &&= direct.canRead;
    canEdit &&= direct.canEdit;
    canManage &&= direct.canManage;
    if (!current.parent_id) break;
    current = documentAccessRow(db, userId, current.parent_id);
    if (!current) return undefined;
  }
  return {
    teamId: row.team_id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    teamRole: row.role,
    visibility: row.document_visibility,
    version: row.version,
    canRead,
    canEdit,
    canManage,
  };
}

export function listVisibleDocumentIds(db: Db, userId: string, teamId: string): string[] {
  const candidates = db.prepare(`
    SELECT d.id
    FROM documents d JOIN spaces s ON s.id=d.space_id
    WHERE s.team_id=?
    ORDER BY d.updated_at DESC, d.id
  `).all(teamId) as Array<{ id: string }>;
  return candidates.filter(({ id }) => getDocumentAccess(db, userId, id)?.canRead).map(({ id }) => id);
}
