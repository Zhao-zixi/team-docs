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
