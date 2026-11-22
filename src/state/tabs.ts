import { signal } from "../signal.ts";

export type Tab = { id: number; title: string };

export const tabs = signal<Tab[]>([]);
export const activeTabId = signal<number | null>(null);

export function setTabTitle(id: number, title: string): void {
  tabs.set(tabs.get().map((t) => (t.id === id ? { ...t, title } : t)));
}
