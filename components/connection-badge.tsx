"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/types/transfer";

const STATUS_CONFIG: Record<ConnectionStatus, { label: string; dot: string; pulse?: boolean }> = {
  idle: { label: "Idle", dot: "bg-muted-foreground" },
  connecting: { label: "Connecting", dot: "bg-amber-400", pulse: true },
  syncing: { label: "Syncing", dot: "bg-amber-400", pulse: true },
  connected: { label: "Connected", dot: "bg-emerald-400" },
  swarm: { label: "Swarm Connected", dot: "bg-sky-400", pulse: true },
  disconnected: { label: "Disconnected", dot: "bg-red-400", pulse: true },
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-sm font-medium text-foreground backdrop-blur-sm">
      <span className="relative flex size-2.5 items-center justify-center">
        {config.pulse && (
          <motion.span
            className={cn("absolute inline-flex size-2.5 rounded-full opacity-60", config.dot)}
            animate={{ scale: [1, 2.4], opacity: [0.6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className={cn("relative inline-flex size-2.5 rounded-full", config.dot)} />
      </span>
      {config.label}
    </div>
  );
}
