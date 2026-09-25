import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

export function validateBody(schema: ZodType) {
  return async (request: FastifyRequest): Promise<void> => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest('请求内容格式无效。');
    (request as FastifyRequest & { body: unknown }).body = parsed.data;
  };
}
