// Actions one panel offers to the others. Each panel fills in its own entries on mount,
// so panels never import each other.

export const commands = {
  /** Opens a terminal tab, optionally in `cwd`. */
  newTab: (_cwd?: string): void => {},
  /** Pastes text into the active terminal as if typed (bracketed paste when enabled). */
  pasteToTerminal: (_text: string): void => {},
  /** Closes the active viewer doc, asking first if it has unsaved changes. */
  closeActiveDoc: (): void => {},
  /**
   * Runs `cd` in the active tab, only while its shell is idle at the prompt. Returns why it
   * did not, or null when it did.
   */
  cdInTerminal: (_dir: string): string | null => "No terminal",
  /** Opens the settings window. */
  openSettings: (): void => {},
  /** Shows or closes the web panel under the viewer. */
  toggleWeb: (): void => {},
  /** Asks what to look up in the local docs server (Caio) and shows the answer. */
  searchDocs: (): void => {},
  /** Enter was pressed in a terminal: a new turn starts (for the git panel's "This turn"). */
  turnStarted: (): void => {},
};
