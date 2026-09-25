import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Bold, Code, Heading2, Italic, List, ListOrdered, Quote, Table2, CheckSquare, Download } from "lucide-react";
import { checkedMarkdownExport, inspectEditorDocument, parseSupportedMarkdown, semanticallyEquivalentMarkdown } from "../markdownSafety";

type Props = { value: string; onChange(value: string): void; disabled?: boolean; onValidityChange?(invalid: boolean): void };
export function MarkdownEditor({ value, onChange, disabled, onValidityChange }: Props) {
  const [mode, setMode] = useState<"source" | "rich">("source");
  const [warning, setWarning] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [structureInvalid, setStructureInvalid] = useState(false);
  const onChangeRef = useRef(onChange), onValidityRef = useRef(onValidityChange);
  useEffect(() => { onChangeRef.current = onChange; onValidityRef.current = onValidityChange; }, [onChange, onValidityChange]);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false }, underline: false }), Markdown, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: false })],
    content: value,
    contentType: "markdown",
    editable: !disabled,
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.docChanged) return;
      let result: ReturnType<typeof checkedMarkdownExport>;
      try { const editorDocument = editor.getJSON(); result = checkedMarkdownExport(editorDocument, () => editor.getMarkdown()); }
      catch { result = { ok: false, reason: "Editor export failed", structureInvalid: true }; }
      const isInvalid = !result.ok;
      setStructureInvalid(!result.ok && result.structureInvalid); setInvalid(isInvalid); onValidityRef.current?.(isInvalid);
      if (!result.ok) { setWarning(result.structureInvalid ? `此编辑内容无法安全导出为 Markdown（${result.reason}）。内容仍保留在编辑器中，请修复后再保存，或下载编辑器草稿。` : "Markdown 正文超过 500KB。请缩短后再保存。"); return; }
      setWarning(""); onChangeRef.current(result.markdown);
    },
  });
  useEffect(() => { if (editor && editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false }); }, [editor, value]);
  useEffect(() => { editor?.setEditable(!disabled); }, [disabled, editor]);
  const switchToRich = () => {
    const check = parseSupportedMarkdown(value);
    if (!check.ok) { setWarning(`此文档含有富文本暂不支持的 Markdown 语法（${check.reason}）。已保留原文，请使用源码模式编辑。`); return; }
    if (!editor) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    let reason: string | undefined;
    let output = "";
    try {
      const checked = checkedMarkdownExport(editor.getJSON(), () => editor.getMarkdown());
      if (!checked.ok) reason = checked.reason; else output = checked.markdown;
    } catch { reason = "editor export failed"; }
    if (reason || !semanticallyEquivalentMarkdown(value, output)) { setWarning(`富文本转换无法确认内容无损${reason ? `（${reason}）` : ""}。已保留原文，请继续使用源码模式编辑。`); return; }
    setInvalid(false); setStructureInvalid(false); onValidityRef.current?.(false); setWarning(""); setMode("rich");
  };
  const downloadRichDraft = () => {
    if (!editor) return;
    const blob = new Blob([JSON.stringify(editor.getJSON(), null, 2)], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "teamshelf-rich-draft.json"; link.click(); URL.revokeObjectURL(link.href);
  };
  return <div className="markdown-editor">
    <div className="editor-head"><div className="segmented" role="tablist" aria-label="编辑模式"><button type="button" role="tab" aria-selected={mode === "source"} onClick={() => { if(structureInvalid){setWarning("请先在富文本模式修复当前结构，或下载富文本草稿；切换会丢失无法用 Markdown 表示的内容。");return;} setMode("source"); setInvalid(false); onValidityRef.current?.(false); setWarning(""); }}>源码</button><button type="button" role="tab" aria-selected={mode === "rich"} onClick={switchToRich}>富文本</button></div><span className="editor-help">正文以 Markdown 保存</span></div>
    {warning && <div className="inline-note" role="status">{warning}{invalid&&mode==="rich"&&<button className="text-button" type="button" onClick={downloadRichDraft}><Download size={14}/>下载富文本草稿</button>}</div>}
    {mode === "source" ? <textarea aria-label="Markdown 正文" className="source-editor" value={value} disabled={disabled} maxLength={512000} onChange={e => onChange(e.target.value)} spellCheck={false} /> : <>
      <div className="toolbar" role="toolbar" aria-label="格式工具">
        <button aria-label="粗体" title="粗体" disabled={disabled} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16}/></button><button aria-label="斜体" title="斜体" disabled={disabled} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16}/></button><i/>
        <button aria-label="标题" title="标题" disabled={disabled} onClick={() => editor?.chain().focus().toggleHeading({level:2}).run()}><Heading2 size={16}/></button><button aria-label="项目列表" title="项目列表" disabled={disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16}/></button><button aria-label="编号列表" title="编号列表" disabled={disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16}/></button><button aria-label="任务清单" title="任务清单" disabled={disabled} onClick={() => editor?.chain().focus().toggleTaskList().run()}><CheckSquare size={16}/></button><button aria-label="引用" title="引用" disabled={disabled} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16}/></button><button aria-label="代码块" title="代码块" disabled={disabled} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}><Code size={16}/></button><button aria-label="表格" title="表格" disabled={disabled} onClick={() => editor?.chain().focus().insertTable({rows:2,cols:2,withHeaderRow:true}).run()}><Table2 size={16}/></button>
      </div><EditorContent editor={editor} className="rich-editor" />
    </>}
  </div>;
}
