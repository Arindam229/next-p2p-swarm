"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useCallback, useRef } from "react";
import {
  Download,
  FileArchive,
  FileAudio,
  FileText,
  FileVideo,
  File as FileGeneric,
  Gauge,
  Image as ImageIcon,
  PauseCircle,
  ShieldCheck,
  Upload,
  Users,
  PlusCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ConnectionBadge } from "@/components/connection-badge";
import { ShareLink } from "@/components/share-link";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";
import type { FileTransferState, UseP2PResult } from "@/hooks/useP2P";
import { cn } from "@/lib/utils";

function fileIconFor(mime: string): LucideIcon {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("tar")) return FileArchive;
  if (mime.startsWith("text/") || mime.includes("pdf") || mime.includes("document")) return FileText;
  return FileGeneric;
}

interface TransferPanelProps {
  result: UseP2PResult;
  shareLink: string;
}

function FileCard({ state }: { state: FileTransferState }) {
  const { meta, progress, speedBps, etaSeconds, isPaused, isComplete, error, role } = state;
  const verifiedChunks = Math.round((progress / 100) * meta.totalChunks);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-emerald-400">
            {React.createElement(fileIconFor(meta.mime), { className: "size-5" })}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CardTitle className="truncate">{meta.name}</CardTitle>
              <Badge variant="outline" className="text-[10px] uppercase h-5 font-mono">
                {role === "sender" ? "Sending" : "Receiving"}
              </Badge>
            </div>
            <CardDescription>{formatBytes(meta.size)}</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {isPaused && !isComplete && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="flex items-center gap-2 overflow-hidden rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-300"
          >
            <PauseCircle className="size-4 shrink-0" />
            Connection lost - paused at {progress.toFixed(0)}%. Will auto-resume.
          </motion.div>
        )}

        <Progress value={progress}>
          <ProgressLabel>{isComplete ? "Complete" : formatEta(etaSeconds) + " remaining"}</ProgressLabel>
          <ProgressValue />
        </Progress>

        <div className="grid grid-cols-3 gap-3 pt-1 text-center">
          <Stat icon={Gauge} label="Speed" value={formatSpeed(speedBps)} />
          <Stat
            icon={ShieldCheck}
            label="Verified"
            value={`${verifiedChunks}/${meta.totalChunks}`}
          />
          <Stat 
            icon={role === "sender" ? Upload : Download} 
            label="Role" 
            value={role === "sender" ? "Sender" : "Receiver"} 
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function TransferPanel({ result, shareLink }: TransferPanelProps) {
  const { status, peers, files, error, addFile } = result;

  const connectedPeers = peers.filter((p) => p.connected).length;
  const fileEntries = Object.values(files);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAddFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      addFile(file);
    }
  }, [addFile]);

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <ConnectionBadge status={status} />
        <span className="text-sm font-medium tabular-nums text-muted-foreground bg-muted/40 px-3 py-1 rounded-full flex items-center gap-2">
          <Users className="size-4" />
          {connectedPeers} connected
        </span>
      </div>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {fileEntries.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Waiting for files...</CardTitle>
            <CardDescription>
              Connected to the swarm. Waiting for a sender to share files, or you can add a file below.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {fileEntries.map((state) => (
            <FileCard key={state.meta.id} state={state} />
          ))}
        </div>
      )}

      <button
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-emerald-400"
      >
        <PlusCircle className="size-5" />
        Share another file in this room
      </button>
      <input type="file" className="hidden" ref={inputRef} onChange={handleAddFile} />

      {peers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Swarm peers</CardTitle>
            <CardDescription>
              {connectedPeers === 0
                ? "No peers connected"
                : `${connectedPeers} peer${connectedPeers === 1 ? "" : "s"} connected`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {peers.map((peer) => (
                <li
                  key={peer.id}
                  className={cn(
                    "flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs",
                    peer.connected
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                      : "border-border bg-muted/30 text-muted-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      peer.connected ? "bg-emerald-400" : "bg-muted-foreground"
                    )}
                  />
                  {peer.id.slice(0, 8)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Invite more peers</CardTitle>
          <CardDescription>
            Anyone with this link can join the swarm and help distribute the files.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ShareLink link={shareLink} />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-muted/20 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
      <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
    </div>
  );
}
