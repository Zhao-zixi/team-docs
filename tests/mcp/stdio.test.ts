import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig, safeFetch } from "../../src/mcp/stdio";

const servers: ReturnType<typeof createServer>[] = [];
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server address.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("stdio bridge configuration", () => {
  it("accepts a fixed HTTP(S) /mcp endpoint with account credentials", () => {
    const config = parseBridgeConfig({ TEAMSHELF_MCP_URL: "https://docs.example.test/team/mcp", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" });
    expect(config.endpoint.href).toBe("https://docs.example.test/team/mcp");
    expect(config.email).toBe("user@example.test");
    expect(config.password).toBe("opaque-secret");
  });

  it.each([
    ["missing endpoint", { TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["missing email", { TEAMSHELF_MCP_URL: "https://docs.example.test/mcp", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["missing password", { TEAMSHELF_MCP_URL: "https://docs.example.test/mcp", TEAMSHELF_MCP_EMAIL: "user@example.test" }],
    ["non HTTP scheme", { TEAMSHELF_MCP_URL: "file:///mcp", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["userinfo", { TEAMSHELF_MCP_URL: "https://user:pass@docs.example.test/mcp", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["query", { TEAMSHELF_MCP_URL: "https://docs.example.test/mcp?token=opaque-secret", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["fragment", { TEAMSHELF_MCP_URL: "https://docs.example.test/mcp#opaque-secret", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["wrong endpoint", { TEAMSHELF_MCP_URL: "https://docs.example.test/admin", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "opaque-secret" }],
    ["password above length limit", { TEAMSHELF_MCP_URL: "https://docs.example.test/mcp", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: "x".repeat(129) }],
  ])("rejects %s without echoing credentials", (_label, env) => {
    let error = "";
    try { parseBridgeConfig(env as Record<string, string | undefined>); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    expect(error).not.toContain("opaque-secret");
    expect(error).not.toBe("");
  });

  it("preserves control characters in passwords because Basic encodes them before HTTP transport", () => {
    const password = "line one\nline two\0tail";
    const config = parseBridgeConfig({ TEAMSHELF_MCP_URL: "https://docs.example.test/mcp", TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: password });
    expect(config.password).toBe(password);
  });

  it("rejects HTTP redirects instead of forwarding Basic credentials", async () => {
    let redirectedRequestCount = 0;
    const destination = createServer((_request, response) => { redirectedRequestCount++; response.end("unexpected"); });
    const destinationUrl = await listen(destination);
    const redirector = createServer((_request, response) => { response.writeHead(302, { Location: `${destinationUrl}/capture` }); response.end(); });
    const redirectUrl = `${await listen(redirector)}/mcp`;
    const basicSecret = `Basic ${Buffer.from("user@example.test:opaque-secret").toString("base64")}`;
    await expect(safeFetch(redirectUrl, { headers: { Authorization: basicSecret } })).rejects.toThrow();
    expect(redirectedRequestCount).toBe(0);
  });
});
const bridgeSecret = "stdio-test-secret-never-log";
const bridgePath = resolve("src/mcp/stdio.ts");

async function startFixture(options: { redirectTo?: string; isRevoked?: () => boolean } = {}) {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "stdio-test-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.registerTool("whoami", { description: "Return fixture identity" }, async () => ({ content: [{ type: "text" as const, text: "fixture viewer" }] }));
    mcp.registerTool("create_document", { description: "A write-only fixture tool", inputSchema: { title: z.string() } }, async () => ({ content: [{ type: "text" as const, text: "write denied by read scope" }], isError: true }));
    return mcp;
  }, { responseMode: "json" });
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (options.redirectTo) { outgoing.writeHead(302, { Location: options.redirectTo }); outgoing.end(); return; }
    const expected = `Basic ${Buffer.from(`user@example.test:${bridgeSecret}`).toString("base64")}`;
    if (incoming.headers.authorization !== expected || options.isRevoked?.()) { outgoing.writeHead(401, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ error: "invalid_credentials" })); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const method = incoming.method ?? "POST";
      const request = new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
      const response = await handler.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  const endpoint = `${await listen(server)}/mcp`;
  return { server, endpoint };
}

async function startStdioClient(endpoint: string, onStderr: (chunk: string) => void) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", bridgePath],
    cwd: process.cwd(),
    env: { ...process.env, TEAMSHELF_MCP_URL: endpoint, TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: bridgeSecret },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-bridge-test", version: "1.0.0" });
  const exited = new Promise<void>(resolve => { transport.onclose = resolve; });
  const connected = client.connect(transport);
  const child = (transport as unknown as { _process?: { stderr?: NodeJS.ReadableStream } })._process;
  child?.stderr?.on("data", chunk => onStderr(chunk.toString()));
  await connected;
  return { client, transport, exited };
}

describe("official MCP stdio bridge integration", () => {
  it("forwards tool listing, read calls, denied writes and revoked credentials, then exits on EOF", async () => {
    let revoked = false;
    const { endpoint } = await startFixture({ isRevoked: () => revoked });
    let logs = "";
    const { client, exited } = await startStdioClient(endpoint, chunk => { logs += chunk; });
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["whoami", "create_document"]);
    const identity = await client.callTool({ name: "whoami", arguments: {} });
    expect(identity.content).toContainEqual({ type: "text" as const, text: "fixture viewer" });
    const denied = await client.callTool({ name: "create_document", arguments: { title: "no write" } });
    expect(denied.isError).toBe(true);
    revoked = true;
    let revokedResult = "";
    try { revokedResult = JSON.stringify(await client.callTool({ name: "whoami", arguments: {} })); }
    catch (cause) { revokedResult = cause instanceof Error ? cause.message : String(cause); }
    expect(revokedResult).not.toContain(bridgeSecret);
    await client.close();
    await exited;
    expect(logs).not.toContain(bridgeSecret);
    expect(logs).not.toContain(Buffer.from(`user@example.test:${bridgeSecret}`).toString("base64"));
    expect(logs.toLowerCase()).not.toContain("authorization");
  });

  it("never forwards Basic credentials across an HTTP redirect", async () => {
    let redirectedAuthorization: string | undefined;
    const target = createServer((request, response) => { redirectedAuthorization = request.headers.authorization; response.end("unexpected"); });
    const destination = `${await listen(target)}/capture`;
    const { endpoint } = await startFixture({ redirectTo: destination });
    let logs = "";
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx/esm", bridgePath], cwd: process.cwd(), env: { ...process.env, TEAMSHELF_MCP_URL: endpoint, TEAMSHELF_MCP_EMAIL: "user@example.test", TEAMSHELF_MCP_PASSWORD: bridgeSecret }, stderr: "pipe" });
    const client = new Client({ name: "stdio-redirect-test", version: "1.0.0" });
    const connected = client.connect(transport);
    const child = (transport as unknown as { _process?: { stderr?: NodeJS.ReadableStream } })._process;
    child?.stderr?.on("data", chunk => { logs += chunk.toString(); });
    await expect(connected).rejects.toThrow();
    expect(redirectedAuthorization).toBeUndefined();
    expect(logs).not.toContain(bridgeSecret);
    expect(logs).not.toContain(Buffer.from(`user@example.test:${bridgeSecret}`).toString("base64"));
    expect(logs.toLowerCase()).not.toContain("authorization");
    await transport.close().catch(() => undefined);
  });
});
