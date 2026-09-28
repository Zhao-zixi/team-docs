export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message = '请求无效。') => new HttpError(400, 'BAD_REQUEST', message);
export const unauthorized = () => new HttpError(401, 'UNAUTHENTICATED', '请先登录。');
export const forbidden = (message = '此操作不允许。') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = () => new HttpError(404, 'NOT_FOUND', '资源不存在或不可访问。');
export const conflict = (message = '资源状态已变化，请刷新后重试。') => new HttpError(409, 'CONFLICT', message);
export const reviewRequired = () => new HttpError(409, 'REVIEW_REQUIRED', '此空间要求审批；请先提交变更提案。');

export interface ErrorBody {
  error: { code: string; message: string };
}
