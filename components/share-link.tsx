"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ShareLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Link copied to clipboard!");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy automatically - select and copy the link manually.");
    }
  };

  return (
    <div className="flex w-full items-center gap-2">
      <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
      <Button type="button" size="icon" variant="secondary" onClick={copy} aria-label="Copy share link">
        {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}
