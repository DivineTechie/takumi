/**
 * Minimal in-memory stand-in for the firebase/firestore calls the Studio screens use (tests only).
 * doc()/collection() return paths; onSnapshot()/getDoc() read them from `store` (odd path length = collection).
 */
export type StoreDoc = Record<string, unknown>;

export const store: { docs: Record<string, StoreDoc>; collections: Record<string, Array<{ id: string } & StoreDoc>>; fail: Set<string> } = {
  docs: {},
  collections: {},
  fail: new Set(),
};

interface Ref {
  path: string;
}

export function resetStore(): void {
  store.docs = {};
  store.collections = {};
  store.fail = new Set();
}

export const firestoreMock = {
  doc: (_db: unknown, ...parts: string[]): Ref => ({ path: parts.join('/') }),
  collection: (_db: unknown, ...parts: string[]): Ref => ({ path: parts.join('/') }),
  query: (ref: Ref): Ref => ref,
  orderBy: () => null,
  where: () => null,
  getDoc: async (ref: Ref) => {
    if (store.fail.has(ref.path)) throw new Error('permission-denied');
    const data = store.docs[ref.path];
    return { exists: () => data !== undefined, data: () => data };
  },
  updateDoc: async () => undefined,
  onSnapshot: (ref: Ref, next: (snap: unknown) => void, error?: (e: Error) => void) => {
    if (store.fail.has(ref.path)) {
      error?.(new Error('permission-denied'));
      return () => undefined;
    }
    if (ref.path.split('/').length % 2 === 1) {
      const rows = store.collections[ref.path] || [];
      next({
        empty: rows.length === 0,
        forEach: (fn: (d: { id: string; data: () => StoreDoc }) => void) =>
          rows.forEach((row) => fn({ id: row.id, data: () => row })),
      });
    } else {
      const data = store.docs[ref.path];
      next({ exists: () => data !== undefined, data: () => data });
    }
    return () => undefined;
  },
};
