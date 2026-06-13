"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Loader2, Network } from "lucide-react";

import { GridBackground } from "@/components/grid-background";
import { TransferPanel } from "@/components/transfer-panel";
import { useP2P } from "@/hooks/useP2P";
import { takePendingShare } from "@/lib/transfer-store";

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = params.id;

  const [ready, setReady] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [initialFile, setInitialFile] = useState<File | null>(null);
  const [shareLink, setShareLink] = useState("");

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const key = new URLSearchParams(hash).get("key");

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEncryptionKey(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShareLink(`${window.location.origin}/room/${roomId}${key ? `#key=${key}` : ""}`);

    const pending = takePendingShare(roomId);
    if (pending) setInitialFile(pending.file);

    setReady(true);
  }, [roomId]);

  const result = useP2P({ roomId, initialFile, encryptionKey });

  return (
    <div className="relative flex flex-1 flex-col">
      <GridBackground />

      <header className="relative z-10 mx-auto flex w-full max-w-2xl items-center px-6 py-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-emerald-400"
        >
          <ArrowLeft className="size-4" />
          <span className="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
            <Network className="size-4" />
          </span>
          P2P Web Share
        </Link>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 pb-24 pt-4">
        {ready ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <TransferPanel result={result} shareLink={shareLink} />
          </motion.div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-emerald-400" />
            <p className="text-sm">Opening secure room…</p>
          </div>
        )}
      </main>
    </div>
  );
}
