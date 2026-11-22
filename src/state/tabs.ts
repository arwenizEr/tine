import { signal } from "../signal.ts";

/** A terminal tab. `cwd` comes from the shell's OSC 7 reports; null until the first prompt. */
export type Tab = { id: number; title: string; cwd: string | null };

export const tabs = signal<Tab[]>([]);
export const activeTabId = signal<number | null>(null);

const update = (id: number, change: Partial<Tab>) =>
  tabs.set(tabs.get().map((t) => (t.id === id ? { ...t, ...change } : t)));

export const setTabTitle = (id: number, title: string) => update(id, { title });

export function setTabCwd(id: number, cwd: string): void {
  if (tabs.get().find((t) => t.id === id)?.cwd !== cwd) update(id, { cwd });
}

export const activeCwd = (): string | null => tabs.get().find((t) => t.id === activeTabId.get())?.cwd ?? null;
