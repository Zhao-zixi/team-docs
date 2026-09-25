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

export function validateParams(schema: ZodType) {
  return async (request: FastifyRequest): Promise<void> => {
    const parsed = schema.safeParse(request.params);
    if (!parsed.success) throw badRequest('请求路径格式无效。');
    (request as FastifyRequest & { params: unknown }).params = parsed.data;
  };
}
