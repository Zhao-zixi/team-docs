export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type GrantRole = 'viewer' | 'editor';
export type Visibility = 'team' | 'restricted';
export type DocumentVisibility = 'inherit' | 'restricted';
export type AgentScope = 'read' | 'write' | 'manage';

export interface AgentCredentialSummary {
  id: string;
  userId: string;
  userName: string;
  name: string;
  teamId: string;
  spaceId: string | null;
  spaceName?: string;
  scope: AgentScope;
  tokenHint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  canRevoke: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole;
}

export interface Member extends User {
  role: TeamRole;
}

export interface Grant {
  userId: string;
  role: GrantRole;
}

export interface Space {
  id: string;
  teamId: string;
  name: string;
  description: string;
  visibility: Visibility;
  canManage: boolean;
  canEdit: boolean;
}

export interface DocumentSummary {
  id: string;
  spaceId: string;
  title: string;
  excerpt: string;
  visibility: DocumentVisibility;
  version: number;
  updatedAt: string;
  updatedByName: string;
  canEdit: boolean;
  canManage: boolean;
}

export interface Document extends DocumentSummary {
  body: string;
  createdAt: string;
  createdBy: string;
  grants?: Grant[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface Revision {
  id: string;
  version: number;
  title: string;
  body: string;
  createdAt: string;
  authorName: string;
}

export type DraftMode = 'markdown' | 'rich';
export type DraftState = 'editing' | 'reviewing';
export interface Draft {
  id: string;
  documentId: string;
  mode: DraftMode;
  baseVersion: number;
  state: DraftState;
  seq: number;
}
export interface AccessFlags { canRead: boolean; canEdit: boolean; canManage: boolean }
export interface AccessReason { layer: 'team' | 'space' | 'document'; code: string; visibility?: string; grantRole?: string }
export interface AccessImpactTotals {
  membersChanged: number; readGained: number; readLost: number; editGained: number; editLost: number;
  documentsReadGained: number; documentsReadLost: number; documentsEditGained: number; documentsEditLost: number;
}
export interface AccessImpactChange {
  userId: string; name: string; before: AccessFlags; after: AccessFlags;
  beforeReasons: AccessReason[]; afterReasons: AccessReason[];
  documentsReadGained: number; documentsReadLost: number; documentsEditGained: number; documentsEditLost: number;
}
export interface AccessImpactPreview {
  changes: AccessImpactChange[]; totals: AccessImpactTotals; hasMore: boolean; nextOffset: number | null;
}


export type ProposalKind = 'create' | 'update' | 'restore' | 'delete';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'conflicted';
export interface ProposalSummary {
  id: string; teamId: string; spaceId: string; documentId: string | null; kind: ProposalKind;
  authorId: string; authorName: string; baseVersion: number | null; title: string; status: ProposalStatus;
  reviewerId: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null;
}
export interface Proposal extends ProposalSummary { body: string; sourceDraftId: string | null; visibility?: DocumentVisibility; grants?: Grant[]; revisionId?: string | null }

export type CommentSource =
  | { kind: 'published'; version: number }
  | { kind: 'draft'; draftId: string; seq: number }
  | { kind: 'proposal'; proposalId: string };
export interface CommentAnchor { paragraphIndex: number; startOffset: number; endOffset: number }
export interface DocumentComment {
  id: string; documentId: string; parentId: string | null; source: CommentSource; quote: string; anchor: CommentAnchor;
  body: string; authorId: string; authorName: string; mentionUserIds: string[]; resolved: boolean; stale: boolean;
  createdAt: string; updatedAt: string; replies?: DocumentComment[];
}
export interface DocumentWorkflow {
  documentId: string; responsibleUserId: string | null; responsibleName: string | null;
  reviewAt: string | null; lastReviewedAt: string | null; dueAt: string | null; status: 'draft' | 'in_review' | 'published'; metadataVersion: number;
}
export interface TeamReminderSettings { enabled: boolean; senderUserId: string | null }
export interface ExternalRoomSummary {
  id: string; teamId: string; name: string; expiresAt: string; revokedAt: string | null;
  itemCount: number; createdAt: string; createdBy: string; lastAccessAt: string | null;
}
export interface ExternalRoomItem { documentId: string; publishedVersion: number; title: string }
