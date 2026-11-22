// Actions one panel offers to the others. Each panel fills in its own entries on mount,
// so panels never import each other.

export const commands = {
  /** Opens a terminal tab, optionally in `cwd`. */
  newTab: (_cwd?: string): void => {},
  /** Pastes text into the active terminal as if typed (bracketed paste when enabled). */
  pasteToTerminal: (_text: string): void => {},
  /** Closes the active viewer doc, asking first if it has unsaved changes. */
  closeActiveDoc: (): void => {},
};
