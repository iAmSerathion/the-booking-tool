"use client";

import { useState } from "react";
import styles from "../settings/settings.module.css";

// A code block to copy. The text stays selectable when the clipboard is not available.
export function CopySnippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <figure className={styles.snippet}>
      <figcaption>{label}</figcaption>
      <pre>
        <code>{code}</code>
      </pre>
      <div className={styles.actions}>
        <button type="button" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          Copy
        </button>
        <p role="status" className={styles.status}>
          {copied ? "Copied." : ""}
        </p>
      </div>
    </figure>
  );
}
