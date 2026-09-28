import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  markdownToRichJson,
  projectMarkdownDraftToMarkdown,
  projectRichDraftToMarkdown,
  richJsonToMarkdown,
  seedMarkdownDraft,
  seedRichDraftFromMarkdown,
} from "../../src/shared/collaboration-schema";
import { semanticallyEquivalentMarkdown } from "../../src/shared/markdownSafety";

const supported = "# 计划 🗺️\n\n一段 **粗体** 和 *斜体*，以及 [链接](https://example.test/path)。\n\n- 项目\n- [x] 完成\n\n| 名称 | 状态 |\n| --- | --- |\n| 知屿 | 已完成 |\n";

describe("shared collaborative Markdown projections", () => {
  it("roundtrips Markdown through the fixed Tiptap schema and a real Y.XmlFragment", () => {
    const seeded = seedRichDraftFromMarkdown(supported, "协作提案");
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.title.toString()).toBe("协作提案");
    expect(seeded.value.document.getMap("meta").get("title")).toBe(seeded.value.title);
    const projected = projectRichDraftToMarkdown(seeded.value.body);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(semanticallyEquivalentMarkdown(supported, projected.value)).toBe(true);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(seeded.value.document));
    const snapshot = projectRichDraftToMarkdown(restored.getXmlFragment("body"));
    expect(snapshot).toEqual(projected);
    restored.destroy();
    seeded.value.document.destroy();
  });

  it("validates JSON with the actual ProseMirror schema before rich serialization", () => {
    const parsed = markdownToRichJson(supported);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(richJsonToMarkdown(parsed.value).ok).toBe(true);
    const malformed = richJsonToMarkdown({ type: "doc", content: [{ type: "unknownNode" }] });
    expect(malformed.ok).toBe(false);
  });

  it.each([
    ["raw HTML", "<div>unsafe</div>"],
    ["images", "![image](https://example.test/file.png)"],
    ["reference links", "[ref][id]\n\n[id]: https://example.test"],
    ["unsafe links", "[bad](javascript:alert(1))"],
  ])("blocks %s before seeding a rich Y.XmlFragment", (_name, markdown) => {
    const result = seedRichDraftFromMarkdown(markdown);
    expect(result.ok).toBe(false);
  });

  it("blocks rich structures that cannot be projected losslessly", () => {
    const parsed = markdownToRichJson("一行文本");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const json = structuredClone(parsed.value);
    json.content![0]!.content = [{ type: "hardBreak" }];
    expect(richJsonToMarkdown(json)).toEqual({ ok: false, reason: "hardBreak" });
  });

  it("keeps Markdown-mode Y.Text exact even when syntax is not accepted for rich mode", () => {
    const raw = "[ref][id]\n\n[id]: https://example.test\n";
    const document = new Y.Doc();
    const seeded = seedMarkdownDraft(document, raw, "原稿");
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(projectMarkdownDraftToMarkdown(seeded.value.body)).toEqual({ ok: true, value: raw });
    expect(seeded.value.title.toString()).toBe("原稿");
    expect(document.getMap("meta").get("title")).toBe(seeded.value.title);
    document.destroy();
  });
});