import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "docs/images");
const workDir = mkdtempSync(resolve(tmpdir(), "teamshelf-readme-demo-"));
const dataDir = resolve(workDir, "data");
mkdirSync(outputDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

async function freePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port.");
  const port = address.port;
  await new Promise((resolvePromise, reject) => probe.close(error => error ? reject(error) : resolvePromise()));
  return port;
}

const port = await freePort();
const origin = "http://127.0.0.1:" + port;
const setupToken = "readme-demo-only-setup-credential";
const safeEnv = {
  PATH: process.env.PATH || "",
  SystemRoot: process.env.SystemRoot || "",
  WINDIR: process.env.WINDIR || "",
  TEMP: process.env.TEMP || tmpdir(),
  TMP: process.env.TMP || tmpdir(),
  HOME: process.env.HOME || "",
  PORT: String(port),
  APP_ORIGIN: origin,
  SETUP_TOKEN: setupToken,
  DATA_DIR: dataDir,
  COOKIE_SECURE: "false",
  NODE_ENV: "production"
};

let server;
let browser;
try {
  server = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: root,
    env: safeEnv,
    stdio: "ignore",
    windowsHide: true
  });

  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Production server exited before becoming healthy.");
    try {
      const response = await fetch(origin + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
  }
  if (!ready) throw new Error("Production server did not become healthy on its isolated port.");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("heading", { name: "建立你的知屿" }).waitFor();
  await page.getByLabel("初始化口令").fill(setupToken);
  await page.getByLabel("团队名称").fill("星舟产品工作室");
  await page.getByLabel("邮箱").fill("demo-owner@example.test");
  await page.getByLabel("你的姓名").fill("顾屿");
  await page.getByLabel("密码").fill("Demo-Only-Password-2026!");
  await page.getByRole("button", { name: "创建团队空间" }).click();
  await page.getByRole("heading", { name: "给团队知识，一个好去处。" }).waitFor();

  await page.getByRole("button", { name: "新建文档" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建文档" });
  await createDialog.getByLabel("文档标题").fill("发布前核对清单");
  await createDialog.getByLabel("Markdown 正文").fill(
    "# 发布前核对清单\n\n用一份清晰清单，让每次交付更从容。\n\n## 发布前\n\n- [x] 更新变更说明\n- [x] 邀请相关成员评审\n- [ ] 确认值班安排\n\n> 发布完成后，记录结果并同步团队。"
  );
  await createDialog.getByRole("button", { name: "创建文档" }).click();
  await page.getByLabel("文档标题").waitFor();
  await page.getByLabel("文档标题").fill("发布前核对清单");
  await page.getByRole("tab", { name: "源码" }).click();
  await page.waitForTimeout(500);
  const noticeClose = page.getByRole("button", { name: "关闭提示" });
  if (await noticeClose.count()) await noticeClose.click();
  await page.screenshot({ path: resolve(outputDir, "teamshelf-editor-demo.png"), animations: "disabled" });

  await page.getByRole("button", { name: "访问权限", exact: true }).click();
  const accessDialog = page.getByRole("dialog", { name: "访问权限" });
  await accessDialog.getByLabel("访问范围").waitFor();
  await accessDialog.getByRole("button", { name: "保存权限" }).waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outputDir, "teamshelf-access-demo.png"), animations: "disabled" });

  console.log("Created production UI screenshots:");
  console.log(resolve(outputDir, "teamshelf-editor-demo.png"));
  console.log(resolve(outputDir, "teamshelf-access-demo.png"));
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([
      new Promise(resolvePromise => server.once("exit", resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 5000))
    ]);
  }
  rmSync(workDir, { recursive: true, force: true });
}
