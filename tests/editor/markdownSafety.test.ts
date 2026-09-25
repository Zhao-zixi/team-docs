import { describe, expect, it, vi } from "vitest";
import { checkedMarkdownExport, inspectEditorDocument, parseSupportedMarkdown, semanticallyEquivalentMarkdown } from "../../src/client/markdownSafety";

describe("Markdown rich editor safety gate", () => {
  it.each([
    ["# 标题\n\n段落。", "heading and paragraph"],
    ["**粗体** 与 *斜体*，还有 ~~删除线~~。", "inline formatting"],
    ["[知屿](https://example.com) 与 [邮件](mailto:team@example.com)", "safe links"],
    ["- 第一项\n- 第二项", "bullet list"],
    ["1. 一\n2. 二", "ordered list"],
    ["```ts\nconst 岛 = '知屿';\n```", "fenced code"],
    ["> 引用内容\n> 第二行", "blockquote"],
    ["| 名称 | 说明 |\n| --- | --- |\n| 知屿 | 团队文档 |", "GFM table"],
    ["- [x] 已完成\n- [ ] 待办", "GFM task list"],
    ["## 多语言\n\n你好，世界！ 🌿", "unicode"],
    ["`<script>alert(1)</script>`", "HTML-looking inline code"],
  ])("accepts supported %s (%s)", markdown => {
    expect(parseSupportedMarkdown(markdown).ok).toBe(true);
  });

  it.each([
    ["![图片](https://example.com/a.png)", "image"],
    ["[ref][id]\n\n[id]: https://example.com", "reference link"],
    ["<div>不支持</div>", "raw HTML"],
    ["[^1]\n\n[^1]: 注脚", "footnote"],
    ["[危险](javascript:alert(1))", "unsafe protocol"],
  ])("rejects unsupported %s (%s)", markdown => {
    expect(parseSupportedMarkdown(markdown).ok).toBe(false);
  });

  it("compares document meaning while ignoring Markdown spacing", () => {
    expect(semanticallyEquivalentMarkdown("- 知屿\n- TeamShelf", "- 知屿\n\n- TeamShelf\n")).toBe(true);
    expect(semanticallyEquivalentMarkdown("# 标题", "## 标题")).toBe(false);
    expect(semanticallyEquivalentMarkdown("- [x] 完成", "- [ ] 完成")).toBe(false);
  });

  it("does not misclassify HTML text inside fenced code as raw HTML", () => {
    expect(parseSupportedMarkdown("```html\n<div>文本</div>\n```").ok).toBe(true);
  });
});

describe("Tiptap editor document export constraints", () => {
  const table = (content: unknown[]) => ({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content }] }] }] });
  it("accepts one paragraph with inline marks in a Markdown table cell", () => {
    expect(inspectEditorDocument(table([{ type: "paragraph", content: [{ type: "text", text: "知屿", marks: [{ type: "bold" }] }] }]))).toBeUndefined();
  });
  it("blocks multi-paragraph table cells that the Markdown exporter cannot represent", () => {
    expect(inspectEditorDocument(table([{ type: "paragraph", content: [{ type: "text", text: "一段" }] }, { type: "paragraph", content: [{ type: "text", text: "二段" }] }]))).toBe("table cell content");
  });
  it("blocks merged cells whose span cannot be expressed in Markdown", () => {
    expect(inspectEditorDocument({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2, rowspan: 1 }, content: [{ type: "paragraph" }] }] }] }] })).toBe("merged table cell");
  });
  it("blocks hard breaks and unsupported marks", () => {
    expect(inspectEditorDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "hardBreak" }] }] })).toBe("hardBreak");
    expect(inspectEditorDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "下划线", marks: [{ type: "underline" }] }] }] })).toBe("underline");
  });
  it("reports malformed link URLs as a safe unsupported document", () => {
    expect(parseSupportedMarkdown("[invalid](http://%zz)").ok).toBe(false);
  });
});
describe("checked editor Markdown export", () => {
  const valid = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "知屿", marks: [{ type: "bold" }] }] }] };
  it("validates the editor schema before exporting a valid Markdown body", () => {
    const exporter = vi.fn(() => "**知屿**");
    expect(checkedMarkdownExport(valid, exporter)).toEqual({ ok: true, markdown: "**知屿**", structureInvalid: false });
    expect(exporter).toHaveBeenCalledOnce();
  });
  it("never calls Markdown serialization when the editor schema is unsupported", () => {
    const exporter = vi.fn(() => "stale safe content");
    const result = checkedMarkdownExport({ type: "doc", content: [{ type: "paragraph", content: [{ type: "hardBreak" }] }] }, exporter);
    expect(result.ok).toBe(false);
    expect(exporter).not.toHaveBeenCalled();
  });
  it("treats Markdown exporter exceptions as invalid and provides no stale body", () => {
    const result = checkedMarkdownExport(valid, () => { throw new Error("serializer failed"); });
    expect(result).toEqual({ ok: false, reason: "Markdown export failed", structureInvalid: true });
  });
  it("rejects unsupported Markdown output before it can replace the saved body", () => {
    expect(checkedMarkdownExport(valid, () => "![image](https://example.test/x.png)").ok).toBe(false);
  });
});
