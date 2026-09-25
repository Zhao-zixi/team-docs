export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    headers.set("X-Requested-With", "TeamShelf");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api${path}`, { ...init, method, headers, credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(payload?.error?.code ?? "request_failed", payload?.error?.message ?? `请求失败（${response.status}）`, response.status);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? response.json() : response.text()) as Promise<T>;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, json("POST", body)),
  patch: <T>(path: string, body?: unknown) => request<T>(path, json("PATCH", body)),
  put: <T>(path: string, body?: unknown) => request<T>(path, json("PUT", body)),
  delete: <T>(path: string) => request<T>(path, json("DELETE")),
};
