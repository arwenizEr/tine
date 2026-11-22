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

/**
 * App shortcuts use Cmd on macOS and Ctrl+Shift on Linux; everything else goes to the focused view.
 * On macOS, Cmd+C/V and Cmd+N/O are left to the native menu, which handles them itself.
 */
export function keyAction(e: KeyLike, mac: boolean): KeyAction | null {
  if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { type: "send", data: SHIFT_ENTER };
  }
  const appMod = mac
    ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
  if (!appMod) return null;

  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { type: "selectTab", index: Number(digit[1]) - 1 };

  switch (e.key.toLowerCase()) {
    case "t":
      return { type: "newTab" };
    case "w":
      return { type: "closeTab" };
    case "k":
      return { type: "clear" };
    case "b":
      return { type: "toggleSidebar" };
    case "j":
      return { type: "toggleViewer" };
    case "c":
      return mac ? null : { type: "copy" };
    case "v":
      return mac ? null : { type: "paste" };
    case "n":
      return mac ? null : { type: "newFile" };
    case "o":
      return mac ? null : { type: "openFolder" };
  }
  return null;
}
