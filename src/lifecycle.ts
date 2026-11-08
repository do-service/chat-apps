export function isAbortedNavigation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errno" in error && error.errno === -3;
}

type RecoveryPorts = {
  hasWindow(): boolean;
  isQuitting(): boolean;
  schedule(callback: () => void): void;
  recoverHidden(): void;
};

// A renderer-initiated window.close() destroys its WebContents without the native close guard.
// Recover to a script-free local page, not to the closing remote page, to avoid reload/close loops.
export function createHiddenRecoveryScheduler(ports: RecoveryPorts): () => void {
  let pending = false;
  return () => {
    if (pending || ports.isQuitting() || ports.hasWindow()) return;
    pending = true;
    ports.schedule(() => {
      try {
        if (!ports.isQuitting() && !ports.hasWindow()) ports.recoverHidden();
      } finally { pending = false; }
    });
  };
}
