import type { Extensions, JSONContent } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import * as Y from "yjs";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { checkedMarkdownExport, inspectEditorDocument, markdownByteLength, parseSupportedMarkdown, semanticallyEquivalentMarkdown } from "./markdownSafety.js";

export const COLLABORATIVE_BODY_FIELD = "body";
export const COLLABORATIVE_META_FIELD = "meta";
export const COLLABORATIVE_TITLE_FIELD = "title";
export type CollaborativeDraftMode = "markdown" | "rich";
export type Projection<T> = { ok: true; value: T } | { ok: false; reason: string };

export function createCollaborationExtensions(): Extensions {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false }, underline: false, undoRedo: false }),
    Markdown,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: false }),
  ];
}

const extensions = createCollaborationExtensions();
const schema = getSchema(extensions);
const markdownManager = new MarkdownManager({ extensions });

function validateEditorJson(value: JSONContent): Projection<JSONContent> {
  const issue = inspectEditorDocument(value);
  if (issue) return { ok: false, reason: issue };
  try {
    schema.nodeFromJSON(value).check();
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid ProseMirror document" };
  }
}

export function markdownToRichJson(markdown: string): Projection<JSONContent> {
  if (markdownByteLength(markdown) > 512000) return { ok: false, reason: "Markdown body exceeds 500 KB" };
  const parsed = parseSupportedMarkdown(markdown);
  if (!parsed.ok) return { ok: false, reason: `unsupported Markdown: ${parsed.reason}` };
  try {
    const json = markdownManager.parse(markdown) as JSONContent;
    const valid = validateEditorJson(json);
    if (!valid.ok) return valid;
    const checked = checkedMarkdownExport(json, () => markdownManager.serialize(json));
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if (!semanticallyEquivalentMarkdown(markdown, checked.markdown)) return { ok: false, reason: "Markdown to rich conversion is not semantically lossless" };
    return { ok: true, value: json };
  } catch {
    return { ok: false, reason: "Markdown parse failed" };
  }
}

export function richJsonToMarkdown(value: JSONContent): Projection<string> {
  const valid = validateEditorJson(value);
  if (!valid.ok) return valid;
  const checked = checkedMarkdownExport(value, () => markdownManager.serialize(value));
  return checked.ok ? { ok: true, value: checked.markdown } : { ok: false, reason: checked.reason };
}

export interface SeededRichDraft {
  document: Y.Doc;
  body: Y.XmlFragment;
  title: Y.Text;
}

export function getCollaborativeTitle(document: Y.Doc): Y.Text | null {
  const title = document.getMap<Y.Text>(COLLABORATIVE_META_FIELD).get(COLLABORATIVE_TITLE_FIELD);
  return title instanceof Y.Text ? title : null;
}

function ensureTitle(document: Y.Doc): Y.Text {
  const meta = document.getMap<Y.Text>(COLLABORATIVE_META_FIELD);
  const existing = meta.get(COLLABORATIVE_TITLE_FIELD);
  if (existing instanceof Y.Text) return existing;
  const title = new Y.Text();
  meta.set(COLLABORATIVE_TITLE_FIELD, title);
  return title;
}
export function seedRichDraftFromMarkdown(markdown: string, title = ""): Projection<SeededRichDraft> {
  const converted = markdownToRichJson(markdown);
  if (!converted.ok) return converted;
  try {
    const document = new Y.Doc();
    const body = document.getXmlFragment(COLLABORATIVE_BODY_FIELD);
    const titleText = ensureTitle(document);
    if (title) titleText.insert(0, title);
    prosemirrorToYXmlFragment(schema.nodeFromJSON(converted.value), body);
    return { ok: true, value: { document, body, title: titleText } };
  } catch {
    return { ok: false, reason: "rich draft seed failed" };
  }
}

export function projectRichDraftToMarkdown(body: Y.XmlFragment): Projection<string> {
  try {
    const root = yXmlFragmentToProseMirrorRootNode(body, schema);
    return richJsonToMarkdown(root.toJSON() as JSONContent);
  } catch {
    return { ok: false, reason: "invalid collaborative rich document" };
  }
}

export function seedMarkdownDraft(document: Y.Doc, markdown: string, title = ""): Projection<{ body: Y.Text; title: Y.Text }> {
  if (markdownByteLength(markdown) > 512000) return { ok: false, reason: "Markdown body exceeds 500 KB" };
  const body = document.getText(COLLABORATIVE_BODY_FIELD);
  const titleText = ensureTitle(document);
  if (body.length || titleText.length) return { ok: false, reason: "collaborative draft is already initialized" };
  try {
    document.transact(() => {
      if (markdown) body.insert(0, markdown);
      if (title) titleText.insert(0, title);
    });
    return { ok: true, value: { body, title: titleText } };
  } catch {
    return { ok: false, reason: "Markdown draft seed failed" };
  }
}

export function projectMarkdownDraftToMarkdown(body: Y.Text): Projection<string> {
  const markdown = body.toString();
  return markdownByteLength(markdown) <= 512000
    ? { ok: true, value: markdown }
    : { ok: false, reason: "Markdown body exceeds 500 KB" };
}