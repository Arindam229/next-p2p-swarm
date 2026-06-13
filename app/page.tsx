import { Lock, Network, HardDrive, RefreshCw } from "lucide-react";
import { GridBackground } from "@/components/grid-background";
import { Dropzone } from "@/components/dropzone";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";

const features = [
  {
    icon: Lock,
    title: "Zero-knowledge encryption",
    description:
      "Files are encrypted with AES-256-GCM before they ever leave your browser. The decryption key only ever lives in the URL fragment.",
  },
  {
    icon: Network,
    title: "Mesh swarm transfers",
    description:
      "When more peers join a room, they download different chunks from each other simultaneously - just like a private BitTorrent swarm.",
  },
  {
    icon: HardDrive,
    title: "Large file support",
    description:
      "Incoming chunks stream straight to disk via the Origin Private File System, bypassing browser RAM limits for 500MB+ files.",
  },
  {
    icon: RefreshCw,
    title: "Auto-resume on churn",
    description:
      "Every chunk is hashed with SHA-256. If a peer drops mid-transfer, the swarm pauses and resumes from the last verified chunk.",
  },
];

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col">
      <GridBackground />

      <header className="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
            <Network className="size-4" />
          </span>
          P2P Web Share
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Badge variant="outline" className="gap-1.5 text-muted-foreground hidden sm:inline-flex">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Secure. Private. Fast.
          </Badge>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-6 pb-24 pt-12 sm:pt-20">
        <div className="mb-10 max-w-2xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Send files{" "}
            <span className="bg-gradient-to-r from-emerald-400 to-sky-400 bg-clip-text text-transparent">
              browser to browser
            </span>
          </h1>
          <p className="mt-4 text-balance text-base text-muted-foreground sm:text-lg">
            Drop a file, get a private link, and stream it directly to whoever
            opens it - encrypted end-to-end for your privacy.
          </p>
        </div>

        <Dropzone />

        <div className="mt-20 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border bg-card/40 p-5 backdrop-blur-sm"
            >
              <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-muted/50 text-emerald-400">
                <feature.icon className="size-4.5" />
              </div>
              <h3 className="text-sm font-medium text-foreground">{feature.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </main>

      <footer className="relative z-10 border-t border-border/60 py-6 text-center text-xs text-muted-foreground">
        Built with Next.js, WebRTC &amp; the Web Crypto API. Designed with privacy in mind.
      </footer>
    </div>
  );
}
