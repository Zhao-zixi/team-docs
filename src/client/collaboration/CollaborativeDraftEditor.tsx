import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import { createCollaborationExtensions, getCollaborativeTitle, projectMarkdownDraftToMarkdown, projectRichDraftToMarkdown } from "../../shared/collaboration-schema";
import type { CollaborativeDraftMode } from "../../shared/collaboration-schema";

type PresenceUser = { name: string; color: string };

export interface CollaborativeDraftEditorProps {
  mode: CollaborativeDraftMode;
  document: Y.Doc;
  provider: WebsocketProvider;
  canWrite: boolean;
  presenceUser: PresenceUser;
  onProjection?(result: { ok: true; title: string; body: string } | { ok: false; reason: string }): void;
  onSyncState?(state: "connecting" | "connected" | "disconnected" | "synced"): void;
}

function replaceYText(text: Y.Text, next: string) {
  const before = text.toString();
  let start = 0;
  while (start < before.length && start < next.length && before[start] === next[start]) start++;
  let suffix = 0;
  while (suffix < before.length - start && suffix < next.length - start && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  if (start === before.length && start === next.length) return;
  text.doc?.transact(() => {
    if (before.length - start - suffix) text.delete(start, before.length - start - suffix);
    const inserted = next.slice(start, next.length - suffix);
    if (inserted) text.insert(start, inserted);
  });
}

function useTitle(document: Y.Doc, mode: CollaborativeDraftMode, canWrite: boolean, onProjection?: CollaborativeDraftEditorProps["onProjection"]) {
  const title = getCollaborativeTitle(document);
  const projectionRef = useRef(onProjection);
  const [value, setValue] = useState(() => title?.toString() ?? "");
  useEffect(() => { projectionRef.current = onProjection; }, [onProjection]);
  useEffect(() => {
    if (!title) return;
    const update = () => {
      const next = title.toString();
      setValue(next);
      const projected = mode === "markdown" ? projectMarkdownDraftToMarkdown(document.getText("body")) : projectRichDraftToMarkdown(document.getXmlFragment("body"));
      projectionRef.current?.(projected.ok ? { ok: true, title: next, body: projected.value } : { ok: false, reason: projected.reason });
    };
    title.observe(update);
    update();
    return () => title.unobserve(update);
  }, [title, document, mode]);
  return <label className="collab-title-field">
    <span>草稿标题</span>
    <input aria-label="协作文档标题" value={value} maxLength={160} disabled={!canWrite || !title} onChange={(event) => {
      const next = event.currentTarget.value;
      setValue(next);
      if (title) replaceYText(title, next);
    }} />
  </label>;
}

function connectionLabel(provider: WebsocketProvider, synced: boolean) {
  if (!provider.wsconnected) return "连接中";
  return synced ? "已连接" : "正在同步";
}

export function CollaborativeDraftEditor(props: CollaborativeDraftEditorProps) {
  const { mode, document, provider, canWrite, presenceUser, onProjection, onSyncState } = props;
  const [synced, setSynced] = useState(provider.synced);
  const [connection, setConnection] = useState(provider.wsconnected ? "connected" : "connecting");
  const projectionRef = useRef(onProjection);
  useEffect(() => { projectionRef.current = onProjection; }, [onProjection]);
  useEffect(() => {
    const handleSync = (value: boolean) => setSynced(value);
    const handleStatus = ({ status }: { status: "connected" | "disconnected" | "connecting" }) => setConnection(status);
    provider.on("sync", handleSync);
    provider.on("status", handleStatus);
    onSyncState?.(provider.synced ? "synced" : provider.wsconnected ? "connected" : "connecting");
    return () => {
      provider.off("sync", handleSync);
      provider.off("status", handleStatus);
    };
  }, [provider, onSyncState]);

  return <section className="collab-editor" aria-label="协作草稿编辑器">
    <header className="collab-editor-head">
      <span className={`collab-live-dot ${connection === "connected" ? "online" : ""}`} aria-hidden="true" />
      <span role="status">{connectionLabel(provider, synced)}</span>
      <span className="collab-mode-label">{mode === "markdown" ? "Markdown 协作" : "富文本协作"}</span>
      {!canWrite && <span className="collab-readonly">只读</span>}
    </header>
    <div className="collab-title-wrap"><CollaborativeTitle document={document} mode={mode} canWrite={canWrite} onProjection={onProjection} /></div>
    {mode === "markdown"
      ? <CollaborativeMarkdownBody document={document} provider={provider} canWrite={canWrite} onProjection={onProjection} />
      : <CollaborativeRichBody document={document} provider={provider} canWrite={canWrite} presenceUser={presenceUser} onProjection={onProjection} />}
  </section>;
}

function CollaborativeTitle(props: { document: Y.Doc; mode: CollaborativeDraftMode; canWrite: boolean; onProjection?: CollaborativeDraftEditorProps["onProjection"] }) {
  return useTitle(props.document, props.mode, props.canWrite, props.onProjection);
}

function CollaborativeMarkdownBody({ document, provider, canWrite, onProjection }: Pick<CollaborativeDraftEditorProps, "document" | "provider" | "canWrite" | "onProjection">) {
  const host = useRef<HTMLDivElement>(null);
  const projectionRef = useRef(onProjection);
  const text = useMemo(() => document.getText("body"), [document]);
  useEffect(() => { projectionRef.current = onProjection; }, [onProjection]);
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [markdown(), yCollab(text, provider.awareness), EditorView.editable.of(canWrite), EditorView.contentAttributes.of({ "aria-label": "Markdown 协作正文" }), EditorView.updateListener.of(() => {
          const title = getCollaborativeTitle(document)?.toString() ?? "";
          const body = text.toString();
          projectionRef.current?.({ ok: true, title, body });
        })],
      }),
    });
    const title = getCollaborativeTitle(document)?.toString() ?? "";
    projectionRef.current?.({ ok: true, title, body: text.toString() });
    return () => view.destroy();
  }, [document, text, provider, canWrite]);
  return <div className="collab-source-editor" ref={host} />;
}

function CollaborativeRichBody({ document, provider, canWrite, presenceUser, onProjection }: Pick<CollaborativeDraftEditorProps, "document" | "provider" | "canWrite" | "presenceUser" | "onProjection">) {
  const fragment = useMemo(() => document.getXmlFragment("body"), [document]);
  const projectionRef = useRef(onProjection);
  useEffect(() => { projectionRef.current = onProjection; }, [onProjection]);
  const extensions = useMemo(() => [
    ...createCollaborationExtensions(),
    Collaboration.configure({ fragment, provider }),
    CollaborationCaret.configure({
      provider,
      user: presenceUser,
      render: user => {
        const caret = window.document.createElement("span");
        caret.className = "collaboration-caret";
        caret.style.borderColor = String(user.color ?? "#71877c");
        const label = window.document.createElement("span");
        label.className = "collaboration-caret-label";
        label.style.backgroundColor = String(user.color ?? "#71877c");
        label.textContent = String(user.name ?? "协作者");
        caret.append(label);
        return caret;
      },
      selectionRender: user => ({ class: "collaboration-selection", style: `background-color:${String(user.color ?? "#dbece4")}33` }),
    }),
  ], [fragment, provider, presenceUser]);
  const editor = useEditor({
    extensions,
    editable: canWrite,
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.docChanged) return;
      const projected = projectRichDraftToMarkdown(fragment);
      const title = getCollaborativeTitle(document)?.toString() ?? "";
      projectionRef.current?.(projected.ok ? { ok: true, title, body: projected.value } : { ok: false, reason: projected.reason });
    },
  }, [document, provider, canWrite]);
  useEffect(() => {
    editor?.setEditable(canWrite);
    const projected = projectRichDraftToMarkdown(fragment);
    if (projected.ok) onProjection?.({ ok: true, title: getCollaborativeTitle(document)?.toString() ?? "", body: projected.value });
    else onProjection?.({ ok: false, reason: projected.reason });
  }, [editor, canWrite, document, fragment, onProjection]);
  return <EditorContent editor={editor} className="collab-rich-editor" aria-label="富文本协作正文" />;
}
