"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { parentOrigin, readWidgetPrefill, widgetBookingPage, widgetMessage, type WidgetMessage, widgetPageParam } from "@/lib/core/widget";
import { connectBookingPage, connectEmbed, setWidgetPrefill } from "../../_booking/widget-embed";

// The link to the host page (public/widget.js): reports that the widget is ready and how tall its content is. In the
// window also Escape (keys inside the frame never reach the host page); in a section it takes the host page's prefill
// and lets the booking report "top" and "booked". allowed is the same list the proxy puts into frame-ancestors
// (widgetEmbedOrigins). Messages go only to the verified parent origin, never to "*", and carry no invitee data. Opened
// directly or framed by a page that is not allowed, the bridge does nothing.
export function WidgetBridge({ allowed }: { allowed: string[] }) {
  const section = /^\/widget\/[^/]+\/section(\/|$)/.test(usePathname());
  const origins = allowed.join(" ");
  useEffect(() => {
    if (window.parent === window) return;
    const ancestors = window.location.ancestorOrigins;
    const target = parentOrigin([ancestors?.length ? ancestors[0] : null, document.referrer], origins.split(" "));
    if (!target) return;
    const post = (message: WidgetMessage) => window.parent.postMessage(message, target);
    const disconnectPage = connectBookingPage(widgetBookingPage(target, new URLSearchParams(window.location.search).get(widgetPageParam)));
    const disconnect = section ? connectSection(target, post) : connectWindow(post);
    return () => {
      disconnect();
      disconnectPage();
    };
  }, [origins, section]);
  return null;
}

type Post = (message: WidgetMessage) => void;

// The content's height on every change. Only the widget's root is measured, not the document (body may be taller).
function reportHeight(post: Post): () => void {
  const root = document.querySelector<HTMLElement>("[data-widget-root]");
  let last = -1;
  const report = () => {
    const height = Math.ceil(root?.getBoundingClientRect().height ?? 0);
    if (height !== last) post(widgetMessage("height", (last = height)));
  };
  const observer = new ResizeObserver(report);
  if (root) observer.observe(root);
  report();
  return () => observer.disconnect();
}

function connectWindow(post: Post): () => void {
  const stopHeight = reportHeight(post);
  post(widgetMessage("ready"));
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) post(widgetMessage("close"));
  };
  document.addEventListener("keydown", onKey);
  return () => {
    stopHeight();
    document.removeEventListener("keydown", onKey);
  };
}

// The prefill counts only from the page that framed the section (window.parent) and only from its verified origin.
// Listen before posting "ready", since widget.js sends the prefill in reply.
function connectSection(target: string, post: Post): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== target) return;
    const prefill = readWidgetPrefill(event.data);
    if (prefill) setWidgetPrefill(prefill);
  };
  window.addEventListener("message", onMessage);
  const disconnect = connectEmbed(target);
  const stopHeight = reportHeight(post);
  post(widgetMessage("ready"));
  return () => {
    stopHeight();
    disconnect();
    window.removeEventListener("message", onMessage);
  };
}
