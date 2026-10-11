/** True when a page-code file failed to load, which happens to open tabs after a new deploy. */
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(msg);
}
