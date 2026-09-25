import { z } from 'zod';
import { badRequest } from './errors.js';
const PageSchema = z.object({ offset: z.coerce.number().int().min(0).max(10000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
export interface Page { offset: number; limit: number }
export function parsePage(query: unknown): Page { const parsed = PageSchema.safeParse(query ?? {}); if (!parsed.success) throw badRequest('分页参数无效。'); return parsed.data; }
export function paginate<T>(entries: T[], page: Page) { const items = entries.slice(page.offset, page.offset + page.limit); const hasMore = page.offset + items.length < entries.length; return { entries: items, hasMore, nextOffset: hasMore ? page.offset + items.length : null }; }

export function hasExplicitPage(query: unknown): boolean { return !!query && typeof query === 'object' && ('offset' in query || 'limit' in query); }
