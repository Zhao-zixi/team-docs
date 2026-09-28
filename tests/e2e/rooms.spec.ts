import { expect, test } from "@playwright/test";

const setupToken = "teamshelf-e2e-setup-token-2026-only-for-isolated-tests";
const adminPassword = "Rooms-E2E-setup-password-2026!";

test("external room is usable by an unauthenticated visitor and reveals only published snapshots", async ({ browser, page }) => {
  await page.goto("/");
  await page.getByLabel("初始化口令").fill(setupToken);
  await page.getByLabel("团队名称").fill("资料室测试团队");
  await page.getByLabel("邮箱").fill("room-owner@example.test");
  await page.getByLabel("你的姓名").fill("本地演示管理员");
  await page.getByLabel("管理员密码（15–128个Unicode字符）").fill(adminPassword);
  await page.getByRole("button", { name: "创建团队空间" }).click();
  await expect(page.getByText("团队空间已准备好。")).toBeVisible();

  await page.getByRole("button", { name: "新建知识库" }).click();
  const spaceDialog = page.getByRole("dialog");
  await spaceDialog.getByLabel("知识库名称").fill("合作资料");
  await spaceDialog.getByLabel("默认访问范围").selectOption("team");
  await spaceDialog.getByRole("button", { name: "创建知识库" }).click();
  await expect(page.getByText("知识库已创建。")).toBeVisible();

  await page.getByRole("button", { name: "创建文档" }).click();
  const documentDialog = page.getByRole("dialog");
  await documentDialog.getByLabel("文档标题").fill("季度合作方案");
  await documentDialog.getByLabel("Markdown 正文").fill("# 合作概要\n\n这是一份只分享已发布快照的演示资料。\n\n- 交付计划\n- 联系安排");
  await documentDialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("季度合作方案");

  await page.getByRole("button", { name: "外部资料室" }).click();
  const manager = page.getByRole("dialog", { name: "外部资料室管理" });
  await expect(manager.getByText("新建资料室")).toBeVisible();
  await manager.getByLabel("名称").fill("合作方演示包");
  await manager.getByLabel("访客口令").fill("Visitor-Room-Password-2026!");
  await manager.getByRole("checkbox", { name: /季度合作方案 发布版本/ }).check();
  const createResponse = page.waitForResponse(response => response.url().endsWith("/api/teams/" + new URL(page.url()).searchParams.get("team") + "/rooms") && response.request().method() === "POST");
  await manager.getByRole("button", { name: "创建资料室" }).click();
  expect((await createResponse).status()).toBe(201);
  const oneTimeLink = await manager.getByLabel("一次性访客链接").inputValue();
  expect(new URL(oneTimeLink).pathname).toMatch(/^\/share\/[A-Za-z0-9_-]{40,60}$/);
  await manager.getByRole("button", { name: "关闭并清除" }).click();
  await expect(manager.getByLabel("一次性访客链接")).toHaveCount(0);
  await page.screenshot({ path: "docs/images/external-room-manager.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(async () => (await page.locator(".sidebar").boundingBox())?.x ?? 0).toBeLessThan(-100);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: "docs/images/external-room-manager-375.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(oneTimeLink);
  await visitor.getByLabel("资料室口令").fill("Visitor-Room-Password-2026!");
  await visitor.getByRole("button", { name: "进入资料室" }).click();
  await expect(visitor.getByRole("heading", { name: "季度合作方案" })).toBeVisible();
  await expect(visitor.getByText("这是一份只分享已发布快照的演示资料。")).toBeVisible();
  await expect(visitor.getByText(/本地演示管理员|room-owner@example\.test|资料室测试团队|合作资料/)).toHaveCount(0);
  await expect(visitor.getByText("内部历史")).toHaveCount(0);
  await visitor.screenshot({ path: "docs/images/external-room-visitor.png", fullPage: true });
  await visitorContext.close();
});