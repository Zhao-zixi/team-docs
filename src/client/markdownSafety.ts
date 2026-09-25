import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);
const allowed = new Set(["heading", "paragraph", "text", "strong", "emphasis", "delete", "inlineCode", "code", "link", "blockquote", "list", "listItem", "thematicBreak", "table", "tableRow", "tableCell"]);
const unsupportedNames = new Set(["image", "definition", "footnoteDefinition", "footnoteReference", "linkReference", "imageReference"]);
function inspect(node: RootContent | Root): string | undefined {
  if (unsupportedNames.has(node.type)) return node.type;
  if (!allowed.has(node.type) && node.type !== "root") return node.type;
  if (node.type === "link") {
    try { if (!["http:", "https:", "mailto:"].includes(new URL(node.url, "https://invalid.local").protocol)) return "unsafe link protocol"; }
    catch { return "invalid link URL"; }
  }
  for (const child of "children" in node ? node.children : []) { const issue = inspect(child as RootContent); if (issue) return issue; }
  return undefined;
}
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !["position", "spread"].includes(k)).map(([k, v]) => [k, semantic(v)]));
}
export function parseSupportedMarkdown(markdown: string): { ok: true; tree: Root } | { ok: false; reason: string } {
  try { const tree = parser.parse(markdown) as Root; const issue = inspect(tree); return issue ? { ok: false, reason: issue } : { ok: true, tree }; }
  catch { return { ok: false, reason: "invalid Markdown" }; }
}
export function semanticallyEquivalentMarkdown(source: string, result: string): boolean {
  const a = parseSupportedMarkdown(source), b = parseSupportedMarkdown(result);
  return a.ok && b.ok && JSON.stringify(semantic(a.tree)) === JSON.stringify(semantic(b.tree));
}
export function inspectEditorDocument(value: unknown): string | undefined {
  const visit = (node: any): string | undefined => {
    if (node.type === "hardBreak" || node.type === "image") return node.type;
    if ((node.type === "tableCell" || node.type === "tableHeader") && (node.content?.length !== 1 || node.content[0]?.type !== "paragraph")) return "table cell content";
    for (const mark of node.marks ?? []) if (!["bold", "italic", "strike", "code", "link"].includes(mark.type)) return mark.type;
    for (const child of node.content ?? []) { const issue = visit(child); if (issue) return issue; }
    return undefined;
  };
  try { return visit(value); } catch { return "invalid editor document"; }
}
export const markdownByteLength = (value: string) => new TextEncoder().encode(value).length;
export type CheckedMarkdownExport =
  | { ok: true; markdown: string; structureInvalid: false }
  | { ok: false; reason: string; structureInvalid: boolean };
export function checkedMarkdownExport(document: unknown, exportMarkdown: () => string): CheckedMarkdownExport {
  const structureIssue = inspectEditorDocument(document);
  if (structureIssue) return { ok: false, reason: structureIssue, structureInvalid: true };
  try {
    const markdown = exportMarkdown();
    const parsed = parseSupportedMarkdown(markdown);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, structureInvalid: true };
    if (markdownByteLength(markdown) > 512000) return { ok: false, reason: "Markdown body exceeds 500 KB", structureInvalid: false };
    return { ok: true, markdown, structureInvalid: false };
  } catch {
    return { ok: false, reason: "Markdown export failed", structureInvalid: true };
  }
}