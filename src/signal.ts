/** Minimal observable value. All shared state lives in signals under src/state/. */
export type Signal<T> = {
  get(): T;
  set(value: T): void;
  /** Calls `fn` on every change; returns an unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void;
};

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of [...subscribers]) fn(value);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
