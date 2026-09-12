/** Preserve final frames while allowing an already-closed stream to settle immediately. */
export function waitForTranscriptTail(socket: WebSocket | null, timeoutMs = 1_200): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      socket.removeEventListener("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.addEventListener("close", finish, { once: true });
    // The stream can have closed between the first check and registration.
    if (socket.readyState === WebSocket.CLOSED) finish();
  });
}
