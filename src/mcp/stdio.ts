import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type BridgeConfig = { endpoint: URL; token: string };

export function parseBridgeConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const rawEndpoint = env.TEAMSHELF_MCP_URL;
  const token = env.TEAMSHELF_MCP_TOKEN;
  if (!rawEndpoint) throw new Error("TEAMSHELF_MCP_URL is required.");
  if (!token || !token.trim() || /[\r\n]/.test(token)) throw new Error("TEAMSHELF_MCP_TOKEN is required and must be a single-line value.");

  let endpoint: URL;
  try { endpoint = new URL(rawEndpoint); }
  catch { throw new Error("TEAMSHELF_MCP_URL must be an absolute HTTP(S) MCP endpoint."); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("TEAMSHELF_MCP_URL must use HTTP or HTTPS.");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("TEAMSHELF_MCP_URL must not contain user information, query parameters, or a fragment.");
  if (!(endpoint.pathname === "/mcp" || endpoint.pathname.endsWith("/mcp"))) throw new Error("TEAMSHELF_MCP_URL must point to the fixed /mcp endpoint.");
  return { endpoint, token };
}

export const safeFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });
const stderr = (message: string) => { process.stderr.write(`[teamshelf-mcp-stdio] ${message}\n`); };

export async function runStdioBridge(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { endpoint, token } = parseBridgeConfig(env);
  const remoteTransport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token },
    fetch: safeFetch,
    onInsufficientScope: "throw",
  });
  const remote = new Client({ name: "teamshelf-stdio-bridge", version: "1.0.0" });
  remote.onerror = () => stderr("Remote MCP request failed.");
  remoteTransport.onerror = () => stderr("Remote MCP transport failed.");

  try {
    await remote.connect(remoteTransport);
  } catch {
    await remoteTransport.close().catch(() => undefined);
    throw new Error("Could not connect to the configured TeamShelf MCP endpoint.");
  }

  const server = new Server({ name: "teamshelf-stdio-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async request => {
    try { return await remote.listTools(request.params ?? {}); }
    catch { throw new Error("Remote MCP request failed."); }
  });
  server.setRequestHandler("tools/call", async request => {
    try { return await remote.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} }); }
    catch { throw new Error("Remote MCP request failed."); }
  });

  const stdio = new StdioServerTransport();
  let closed = false;
  const closeRemote = () => {
    if (closed) return;
    closed = true;
    void remote.close().catch(() => stderr("Remote connection cleanup failed."));
  };
  stdio.onclose = closeRemote;
  stdio.onerror = () => stderr("Local stdio transport failed.");
  try {
    await server.connect(stdio);
  } catch {
    closeRemote();
    throw new Error("Could not start the local MCP stdio transport.");
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  runStdioBridge().catch(error => {
    stderr(error instanceof Error ? error.message : "MCP bridge startup failed.");
    process.exitCode = 1;
  });
}