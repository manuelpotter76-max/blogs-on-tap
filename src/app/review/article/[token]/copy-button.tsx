"use client";

import { useState } from "react";

/** Copies text, and also offers it as rich HTML so pasting into a blog editor keeps headings and links. */
export function CopyButton({ text, html, label }: { text: string; html?: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      if (html && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      setDone(false);
    }
  };
  return <button type="button" className="secondary" onClick={copy}>{done ? "Copied" : label}</button>;
}
