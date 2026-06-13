"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Loader2, ShieldCheck, UploadCloud } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";

import { exportKeyToString, generateEncryptionKey } from "@/lib/crypto";
import { setPendingShare } from "@/lib/transfer-store";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Dropzone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setIsPreparing(true);
      setFileName(file.name);

      try {
        const roomId = uuidv4();
        const key = await generateEncryptionKey();
        const keyStr = await exportKeyToString(key);

        setPendingShare({ roomId, file, key: keyStr });

        const link = `${window.location.origin}/room/${roomId}#key=${keyStr}`;
        try {
          await navigator.clipboard.writeText(link);
          toast.success("Share link copied to clipboard!", {
            description: `${file.name} (${formatBytes(file.size)})`,
          });
        } catch {
          toast.info("Room created - copy the link from your address bar to share.");
        }

        router.push(`/room/${roomId}#key=${keyStr}`);
      } catch (e) {
        console.error(e);
        toast.error("Could not prepare the file for sharing.");
        setIsPreparing(false);
        setFileName(null);
      }
    },
    [router]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label="Drop a file or click to choose one to share"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      whileHover={{ scale: isPreparing ? 1 : 1.01 }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isPreparing) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={isPreparing ? undefined : onDrop}
      onClick={() => !isPreparing && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!isPreparing && (e.key === "Enter" || e.key === " ")) {
          inputRef.current?.click();
        }
      }}
      className={cn(
        "group relative flex w-full max-w-xl cursor-pointer flex-col items-center gap-4 rounded-2xl border border-dashed px-8 py-16 text-center transition-colors",
        "border-border bg-card/40 backdrop-blur-sm",
        isDragging && "border-emerald-400/70 bg-emerald-500/5",
        isPreparing && "cursor-wait opacity-80"
      )}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={onInputChange}
        disabled={isPreparing}
      />

      <div
        className={cn(
          "flex size-16 items-center justify-center rounded-full border bg-muted/40 transition-transform",
          "group-hover:scale-105",
          isDragging && "scale-110 border-emerald-400/60 bg-emerald-500/10"
        )}
      >
        {isPreparing ? (
          <Loader2 className="size-7 animate-spin text-emerald-400" />
        ) : (
          <UploadCloud className="size-7 text-muted-foreground transition-colors group-hover:text-emerald-400" />
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-base font-medium text-foreground">
          {isPreparing
            ? `Encrypting ${fileName ?? "file"}…`
            : isDragging
              ? "Drop it like it's hot"
              : "Drag & drop a file to share"}
        </p>
        <p className="text-sm text-muted-foreground">
          {isPreparing
            ? "Generating your private room and copying the link"
            : "or click to browse - nothing is uploaded to a server"}
        </p>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
        <ShieldCheck className="size-3.5" />
        <span>End-to-end encrypted with AES-256-GCM in your browser</span>
      </div>
    </motion.div>
  );
}
