/** Only material uploads whose stored text is ready can unlock questions. */
export function hasReadyMaterials(sessionId: string, materials: Array<{ session_id: string; page_count: number }>) {
  return Boolean(sessionId) && materials.some((material) => material.session_id === sessionId && material.page_count > 0);
}

export function preparationTitle(entered: string, english: boolean, now = new Date()) {
  return entered.trim() || (english ? `Lecture ${now.toLocaleDateString("en-US")}` : `${now.toLocaleDateString("ko-KR")} 수업`);
}

/** Serialize renames per lecture so a slower old request cannot win in storage. */
export function createTitleSaveQueue() {
  const pending = new Map<string, { title: string; promise: Promise<void> }>();
  return (sessionId: string, title: string, save: () => Promise<void>) => {
    const previous = pending.get(sessionId);
    if (previous?.title === title) return previous.promise;
    const promise = (previous?.promise ?? Promise.resolve()).catch(() => {}).then(save);
    const entry = { title, promise };
    pending.set(sessionId, entry);
    void promise.finally(() => { if (pending.get(sessionId) === entry) pending.delete(sessionId); }).catch(() => {});
    return promise;
  };
}

/** A bounded retry identity, independent of the display filename's length. */
export async function audioUploadKey(file: Pick<File, "name" | "size" | "lastModified">) {
  const bytes = new TextEncoder().encode(JSON.stringify([file.name, file.size, file.lastModified]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
