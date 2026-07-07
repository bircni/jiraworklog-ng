"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Bridges Electron main-process events into the Next.js renderer. Currently it
 * refreshes the current route when the timer is stopped from the system tray so
 * the UI reflects the change immediately. No-op outside Electron.
 */
export function ElectronBridge() {
  const router = useRouter();

  useEffect(() => {
    const bridge = window.electron;
    if (!bridge) return;
    return bridge.onTimerStopped(() => {
      router.refresh();
    });
  }, [router]);

  return null;
}
