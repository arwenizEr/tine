import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { basename } from "../paths.ts";

/** Syntax highlighting by file name; language packages load on first use. */
async function languageFor(path: string): Promise<Extension> {
  const desc = LanguageDescription.matchFilename(languages, basename(path));
  return desc ? desc.load().catch(() => []) : [];
}

// Colours come from CSS variables (styles/theme.css), so light and dark switch without
// rebuilding editors.
const theme = [
  EditorView.theme({
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
    ".cm-scroller": { fontFamily: "var(--mono-font)", fontSize: "12.5px" },
    ".cm-content": { caretColor: "var(--fg)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--editor-selection)" },
    ".cm-activeLine": { backgroundColor: "var(--hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--hover)", color: "var(--fg)" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-muted)", border: "none" },
    ".cm-selectionMatch": { backgroundColor: "var(--hover-strong)" },
    ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "1px solid var(--search-match-border)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-match-border)" },
    ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
    ".cm-textfield": { backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-raised)", color: "var(--fg)", border: "1px solid var(--border)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", border: "1px solid var(--border)" },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
      { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
      { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
      { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
      { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
      { tag: [t.tagName, t.heading], color: "var(--syn-tag)", fontWeight: "600" },
      { tag: [t.definition(t.variableName), t.labelName], color: "var(--syn-definition)" },
      { tag: [t.meta, t.processingInstruction], color: "var(--fg-muted)" },
      { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strong, fontWeight: "bold" },
      { tag: t.strikethrough, textDecoration: "line-through" },
      { tag: t.invalid, color: "var(--syn-invalid)" },
    ]),
  ),
];

/** Read-only code view, for diffs: line numbers, search and syntax highlighting. */
export async function readOnlyExtensions(path: string): Promise<Extension[]> {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    search({ top: true }),
    keymap.of(searchKeymap),
    EditorState.readOnly.of(true),
    theme,
    await languageFor(path),
  ];
}

/** A plain-text editor state: line numbers, undo, search (Cmd+F), Cmd+S to save. */
export async function createState(
  path: string,
  text: string,
  opts: { editable: boolean; onSave?: () => void },
): Promise<EditorState> {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorState.readOnly.of(!opts.editable),
      keymap.of([
        { key: "Mod-s", run: () => (opts.onSave?.(), true) },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      theme,
      await languageFor(path),
    ],
  });
}
