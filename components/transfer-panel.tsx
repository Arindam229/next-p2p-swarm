"use client";

import { motion } from "framer-motion";
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ConnectionBadge } from "@/components/connection-badge";
import { ShareLink } from "@/components/share-link";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";
import type { UseP2PResult } from "@/hooks/useP2P";
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

export function TransferPanel({ result, shareLink }: TransferPanelProps) {
  const { status, role, peers, fileMeta, progress, speedBps, etaSeconds, isPaused, isComplete, error } = result;

  const connectedPeers = peers.filter((p) => p.connected).length;
  const Icon = fileMeta ? fileIconFor(fileMeta.mime) : FileGeneric;
  const verifiedChunks = fileMeta ? Math.round((progress / 100) * fileMeta.totalChunks) : 0;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <Badge variant="outline" className="gap-1.5 text-muted-foreground">
          {role === "sender" ? <Upload className="size-3" /> : <Download className="size-3" />}
          {role === "sender" ? "Sending" : role === "receiver" ? "Receiving" : "Waiting for sender"}
        </Badge>
        <ConnectionBadge status={status} />
      </div>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-emerald-400">
              <Icon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="truncate">{fileMeta?.name ?? "Waiting for file info…"}</CardTitle>
              <CardDescription>
                {fileMeta ? formatBytes(fileMeta.size) : "The sender hasn't connected yet"}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {isPaused && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="flex items-center gap-2 overflow-hidden rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-300"
            >
              <PauseCircle className="size-4 shrink-0" />
              Connection lost - paused at {progress.toFixed(0)}%. Will auto-resume from the last
              verified chunk once a peer reconnects.
            </motion.div>
          )}

          <Progress value={fileMeta ? progress : 0}>
            <ProgressLabel>{isComplete ? "Complete" : formatEta(etaSeconds) + " remaining"}</ProgressLabel>
            <ProgressValue />
          </Progress>

          <div className="grid grid-cols-3 gap-3 pt-1 text-center">
            <Stat icon={Gauge} label="Speed" value={formatSpeed(speedBps)} />
            <Stat icon={Users} label="Peers" value={`${connectedPeers}`} />
            <Stat
              icon={ShieldCheck}
              label="Verified"
              value={fileMeta ? `${verifiedChunks}/${fileMeta.totalChunks}` : "—"}
            />
          </div>
        </CardContent>
      </Card>

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
            Anyone with this link can join the swarm and help distribute the file.
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
