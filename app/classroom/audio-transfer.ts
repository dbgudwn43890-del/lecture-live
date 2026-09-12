import type { AudioUploadTransfer } from "../lib/lecture-audio-transfer";

export class AudioTransferError extends Error {
  code: "expired" | "too_large" | "failed";
  constructor(code: AudioTransferError["code"]) { super(code); this.code = code; }
}

/** Upload straight to private storage; only small control requests reach Next. */
export async function transferRecording(file: File, transfer: AudioUploadTransfer, onProgress: (percent: number) => void, signal?: AbortSignal) {
  const { Upload } = await import("tus-js-client");
  const endpoint = new URL(transfer.endpoint);
  const allowedDestination = (url: string) => {
    try {
      const destination = new URL(url);
      return destination.origin === endpoint.origin && (destination.pathname === endpoint.pathname || destination.pathname.startsWith(`${endpoint.pathname}/`));
    } catch { return false; }
  };
  return new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => { signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
    const upload = new Upload(file, {
      endpoint: transfer.endpoint,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 1_000, 3_000, 5_000],
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, "x-signature": transfer.token },
      metadata: { bucketName: transfer.bucketName, objectName: transfer.objectName, contentType: transfer.contentType, cacheControl: "3600" },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      fingerprint: async () => `lecue-recording:${transfer.objectName}:${file.size}:${file.lastModified}`,
      onBeforeRequest(request) {
        // Resumable URLs come from storage/local resume history. Never send the
        // scoped upload token to a different origin or a different API path.
        if (!allowedDestination(request.getURL())) throw new AudioTransferError("failed");
      },
      onProgress: (sent, total) => onProgress(Math.min(100, Math.round(sent / total * 100))),
      onError(error) {
        const status = "originalResponse" in error ? error.originalResponse?.getStatus() : undefined;
        done(new AudioTransferError(status === 401 || status === 403 ? "expired" : status === 413 ? "too_large" : "failed"));
      },
      onSuccess: () => done(),
    });
    const abort = () => { void upload.abort().then(() => done(new AudioTransferError("failed")), () => done(new AudioTransferError("failed"))); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void upload.findPreviousUploads().then(previous => {
      if (signal?.aborted) return;
      const resumable = previous.find(item => item.uploadUrl && allowedDestination(item.uploadUrl));
      if (resumable) upload.resumeFromPreviousUpload(resumable);
      upload.start();
    }).catch(() => done(new AudioTransferError("failed")));
  });
}
