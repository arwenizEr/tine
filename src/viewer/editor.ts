import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
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

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)" },
  ".cm-scroller": { fontFamily: "var(--mono-font)", fontSize: "12.5px" },
  ".cm-gutters": { backgroundColor: "var(--bg)" },
});

/** Read-only code view, for diffs: line numbers, search and syntax highlighting. */
export async function readOnlyExtensions(path: string): Promise<Extension[]> {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    search({ top: true }),
    keymap.of(searchKeymap),
    EditorState.readOnly.of(true),
    oneDark,
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
      oneDark,
      theme,
      await languageFor(path),
    ],
  });
}
