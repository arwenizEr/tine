// Pure key mapping, kept free of DOM and xterm imports so `node --test` can run it.

export type KeyAction =
  | { type: "newTab" }
  | { type: "closeTab" }
  | { type: "selectTab"; index: number }
  | { type: "clear" }
  | { type: "copy" }
  | { type: "paste" }
  | { type: "toggleSidebar" }
  | { type: "toggleViewer" }
  | { type: "newFile" }
  | { type: "openFolder" }
  | { type: "find" }
  | { type: "palette" }
  | { type: "block"; direction: -1 | 1 }
  | { type: "send"; data: string };

export type KeyLike = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** ESC CR: what Claude Code and other agent CLIs read as "newline, don't submit". */
export const SHIFT_ENTER = "\x1b\r";

/** Actions a settings file can rebind, by the name used there. */
export const ACTIONS = {
  newTab: { type: "newTab" },
  closeTab: { type: "closeTab" },
  clear: { type: "clear" },
  toggleSidebar: { type: "toggleSidebar" },
  toggleViewer: { type: "toggleViewer" },
  newFile: { type: "newFile" },
  openFolder: { type: "openFolder" },
  find: { type: "find" },
  palette: { type: "palette" },
  copy: { type: "copy" },
  paste: { type: "paste" },
  prevBlock: { type: "block", direction: -1 },
  nextBlock: { type: "block", direction: 1 },
} satisfies Record<string, KeyAction>;
type ActionName = keyof typeof ACTIONS;

// App shortcuts use Cmd on macOS and Ctrl+Shift on Linux; Ctrl alone always goes to the shell.
// On macOS, copy, paste, New File and Open Folder belong to the native menu, so they have no binding here.
const MAC: Partial<Record<ActionName, string>> = {
  newTab: "cmd+t",
  closeTab: "cmd+w",
  clear: "cmd+k",
  toggleSidebar: "cmd+b",
  toggleViewer: "cmd+j",
  find: "cmd+f",
  palette: "cmd+p",
  prevBlock: "cmd+up",
  nextBlock: "cmd+down",
};
const LINUX: Partial<Record<ActionName, string>> = {
  newTab: "ctrl+shift+t",
  closeTab: "ctrl+shift+w",
  clear: "ctrl+shift+k",
  toggleSidebar: "ctrl+shift+b",
  toggleViewer: "ctrl+shift+j",
  find: "ctrl+shift+f",
  palette: "ctrl+shift+p",
  prevBlock: "ctrl+shift+up",
  nextBlock: "ctrl+shift+down",
  copy: "ctrl+shift+c",
  paste: "ctrl+shift+v",
  newFile: "ctrl+shift+n",
  openFolder: "ctrl+shift+o",
};

type Chord = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string };

/** "cmd+shift+t" -> chord; null if it is not one. */
export function parseChord(text: string): Chord | null {
  const parts = text.toLowerCase().split("+").map((p) => p.trim());
  const key = parts.pop();
  if (!key || !/^([a-z0-9]|up|down)$/.test(key)) return null;
  const chord: Chord = { meta: false, ctrl: false, alt: false, shift: false, key };
  for (const mod of parts) {
    if (mod === "cmd" || mod === "meta") chord.meta = true;
    else if (mod === "ctrl") chord.ctrl = true;
    else if (mod === "alt" || mod === "option") chord.alt = true;
    else if (mod === "shift") chord.shift = true;
    else return null;
  }
  // A shortcut needs Cmd or Ctrl; anything else would swallow ordinary typing.
  return chord.meta || chord.ctrl ? chord : null;
}

export type Keymap = { chord: Chord; action: KeyAction }[];

/** Default bindings for the platform, with the settings file's `[keybindings]` applied. */
export function buildKeymap(mac: boolean, overrides: Record<string, string> = {}): { keymap: Keymap; errors: string[] } {
  const names: Partial<Record<ActionName, string>> = { ...(mac ? MAC : LINUX) };
  const errors: string[] = [];
  for (const [name, chord] of Object.entries(overrides)) {
    if (!(name in ACTIONS)) errors.push(`Unknown action "${name}" in [keybindings].`);
    else if (chord === "" || chord === "none") delete names[name as ActionName];
    else if (!parseChord(chord)) errors.push(`"${chord}" for ${name} is not a shortcut (example: "cmd+shift+t").`);
    else names[name as ActionName] = chord;
  }
  const keymap = Object.entries(names).map(([name, chord]) => ({
    chord: parseChord(chord!)!,
    action: ACTIONS[name as ActionName] as KeyAction,
  }));
  return { keymap, errors };
}

const defaults = { mac: buildKeymap(true).keymap, linux: buildKeymap(false).keymap };

function keyName(e: KeyLike): string {
  const digit = /^Digit(\d)$/.exec(e.code);
  if (digit) return digit[1];
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  return e.key.toLowerCase();
}

export function keyAction(e: KeyLike, mac: boolean, keymap: Keymap = mac ? defaults.mac : defaults.linux): KeyAction | null {
  if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { type: "send", data: SHIFT_ENTER };
  }
  // Cmd+1..9 (Ctrl+Shift+1..9 on Linux) pick a tab; not rebindable.
  const tabMod = mac
    ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (tabMod && digit) return { type: "selectTab", index: Number(digit[1]) - 1 };

  const name = keyName(e);
  for (const { chord, action } of keymap) {
    if (
      chord.key === name &&
      chord.meta === e.metaKey &&
      chord.ctrl === e.ctrlKey &&
      chord.alt === e.altKey &&
      chord.shift === e.shiftKey
    ) {
      return action;
    }
  }
  return null;
}
