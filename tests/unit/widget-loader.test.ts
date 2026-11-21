import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { bookingInputLimits } from "@/lib/core/booking";
import { answerMaxLength, cleanMultiline, cleanText } from "@/lib/core/questions";
import {
  cleanWidgetPage,
  widgetBookedEvent,
  widgetMaxHeight,
  widgetMessage,
  widgetMessageSource,
  widgetPageMax,
  widgetPageParam,
  widgetPath,
  widgetReadyTimeout,
  widgetSectionAttribute,
  widgetTriggerAttribute,
  widgetUnavailableEvent,
} from "@/lib/core/widget";
import de from "@/messages/de.json";
import en from "@/messages/en.json";

// public/widget.js: the protocol and limits of lib/core, no tracking, a classic ES2019 script, and its behaviour on a
// small fake host page (just enough DOM for the loader). The real browser runs it in tests/e2e/widget.spec.ts.

const script = readFileSync(new URL("../../public/widget.js", import.meta.url), "utf8");
const css = /const css = `([\s\S]*?)`;/.exec(script)![1];

describe("widget.js: source", () => {
  it("parses as a classic ES2019 script and runs in its own strict function", () => {
    const messages = new Linter().verify(script, [{ languageOptions: { ecmaVersion: 2019, sourceType: "script" } }]);
    expect(messages.filter((m) => m.fatal)).toEqual([]);
    expect(script).toMatch(/^\/\*[\s\S]*?\*\/\n\(function \(\) \{\n {2}"use strict";\n/);
    expect(script.trimEnd().endsWith("})();")).toBe(true);
  });

  it("speaks protocol v1 of lib/core/widget.ts", () => {
    for (const value of [widgetMessageSource, widgetTriggerAttribute, widgetSectionAttribute, widgetBookedEvent, widgetUnavailableEvent, widgetPageParam]) {
      expect(script).toContain(`"${value}"`);
    }
    expect(script).toContain(`const readyTimeout = ${widgetReadyTimeout};`);
    expect(script).toContain(`const maxHeight = ${widgetMaxHeight};`);
    expect(script).toContain(`const pageMax = ${widgetPageMax};`);
    expect(script).toContain("data.v !== 1");
    for (const type of ["ready", "height", "close", "top", "booked"]) expect(script).toContain(`data.type === "${type}"`);
    expect(script).toContain('type: "prefill"');
    expect(script).toContain("window.BookingWidget = Object.freeze({ v: 1, mount: mount, unmount: unmount })");
  });

  it("has the labels of messages/*.json", () => {
    expect(script).toContain(`en: { dialog: ${JSON.stringify(en["widget.title"])}, close: ${JSON.stringify(en["widget.close"])} }`);
    expect(script).toContain(`de: { dialog: ${JSON.stringify(de["widget.title"])}, close: ${JSON.stringify(de["widget.close"])} }`);
  });

  it.each(["document.cookie", "localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "console.", "history.", "eval(", '"*"'])(
    "does not use %s",
    (word) => {
      expect(script).not.toContain(word);
    },
  );

  it("never stops the host page's clicks", () => {
    expect(script).not.toMatch(/stop(Immediate)?Propagation\(/);
  });

  it("styles only its own dialog and section frames, with colors and fonts from --booking-widget-* variables", () => {
    expect(css).not.toMatch(/@layer|@import/);
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/[^{}]+(?=\{)/g)!
      .map((s) => s.trim())
      .filter((s) => !s.startsWith("@") && !/^(from|to)$/.test(s));
    for (const selector of selectors) expect(selector).toMatch(/^(dialog\[data-booking-widget-window\]|\[data-booking-section\] > iframe)/);
    for (const line of css.split("\n").filter((l) => /^\s*(color|background|border|font|outline|box-shadow):/.test(l))) {
      if (/:\s*(0|none|transparent|inherit|currentColor);/.test(line)) continue;
      expect(line).toMatch(/var\(--booking-widget-[a-z-]+, /);
    }
  });
});

// The fake host page ------------------------------------------------------------------------------------------------

type Handler = (event: FakeEvent | FakeCustomEvent) => void;
type EventInit = Partial<Pick<FakeEvent, "target" | "button" | "detail" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "origin" | "source" | "data">>;

class FakeEvent {
  target: FakeNode | null = null;
  button = 0;
  detail = 1;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;
  altKey = false;
  origin = "";
  source: unknown = null;
  data: unknown = null;
  defaultPrevented = false;
  constructor(
    readonly type: string,
    init: EventInit = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeCustomEvent {
  readonly bubbles: boolean;
  readonly detail: unknown;
  constructor(
    readonly type: string,
    init: { bubbles?: boolean; detail?: unknown } = {},
  ) {
    this.bubbles = init.bubbles === true;
    this.detail = init.detail ?? null;
  }
}

class FakeTarget {
  readonly listeners = new Map<string, Handler[]>();
  addEventListener(type: string, handler: Handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  emit<E extends FakeEvent | FakeCustomEvent>(event: E): E {
    for (const handler of this.listeners.get(event.type) ?? []) handler.call(this, event);
    return event;
  }
}

const attributeIn = (selector: string) => /^\[([\w-]+)\]$/.exec(selector)![1];

class FakeNode extends FakeTarget {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  innerHTML = "";
  textContent = "";
  clientWidth = 0;
  rect = { top: 0 };
  scrollMargin = "0px";
  constructor(
    tag: string,
    readonly doc: FakeDocument,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get src() {
    return this.getAttribute("src") ?? "";
  }
  get isConnected(): boolean {
    return this.parentNode ? this.parentNode.isConnected : this === this.doc.documentElement;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  appendChild<T extends FakeNode>(child: T): T {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  closest(selector: string): FakeNode | null {
    if (this.hasAttribute(attributeIn(selector))) return this;
    return this.parentNode ? this.parentNode.closest(selector) : null;
  }
  focus() {
    this.doc.activeElement = this;
  }
  getBoundingClientRect() {
    return { ...this.rect };
  }
  dispatchEvent(event: FakeCustomEvent) {
    this.emit(event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return true;
  }
  descendants(): FakeNode[] {
    return this.children.flatMap((node) => [node, ...node.descendants()]);
  }
}

class FakeDialog extends FakeNode {
  open = false;
  showModal() {
    if (this.doc.failModal || !this.isConnected || this.open) throw new Error("InvalidStateError");
    this.open = true;
    this.children.find((node) => node.hasAttribute("autofocus"))?.focus();
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit(new FakeEvent("close", { target: this }));
  }
}

// contentWindow exists only while the frame is in the document; postMessage records what the loader sends over.
class FakeFrame extends FakeNode {
  readonly sent: { message: unknown; target: unknown }[] = [];
  readonly view = { postMessage: (message: unknown, target: unknown) => this.sent.push({ message, target }) };
  get contentWindow() {
    return this.isConnected ? this.view : null;
  }
}

class FakeDocument {
  readonly baseURI = "https://example.com/pricing";
  readonly documentElement: FakeNode;
  readonly head: FakeNode;
  readonly body: FakeNode;
  currentScript: FakeNode | null = null;
  activeElement: FakeNode | null = null;
  failModal = false;
  constructor() {
    this.documentElement = new FakeNode("html", this);
    this.head = this.documentElement.appendChild(new FakeNode("head", this));
    this.body = this.documentElement.appendChild(new FakeNode("body", this));
    this.body.style.overflow = "auto";
  }
  createElement(tag: string): FakeNode {
    if (tag === "dialog") return new FakeDialog(tag, this);
    if (tag === "iframe") return new FakeFrame(tag, this);
    return new FakeNode(tag, this);
  }
  querySelectorAll(selector: string) {
    return this.documentElement.descendants().filter((node) => node.hasAttribute(attributeIn(selector)));
  }
  getElementsByTagName(tag: string) {
    return this.documentElement.descendants().filter((node) => node.tagName === tag.toUpperCase());
  }
}

type ObserverCallback = (records: { isIntersecting: boolean; target: FakeNode }[]) => void;

class FakeObserver {
  readonly targets: FakeNode[] = [];
  constructor(
    readonly callback: ObserverCallback,
    readonly options: unknown,
  ) {}
  observe(target: FakeNode) {
    this.targets.push(target);
  }
  disconnect() {
    this.targets.length = 0;
  }
  report(isIntersecting: boolean) {
    this.callback(this.targets.map((target) => ({ isIntersecting, target })));
  }
}

type FakeHandle = { update(prefill?: unknown): void; unmount(): void };
type FakeApi = { v: number; mount(element: unknown, prefill?: unknown): FakeHandle | null; unmount(element: unknown): boolean };

class FakeWindow extends FakeTarget {
  innerWidth = 1440;
  innerHeight = 900;
  readonly location: { href: string; pathname: unknown } = { href: "https://example.com/pricing", pathname: "/pricing" };
  HTMLDialogElement: unknown = FakeDialog;
  readonly observers: FakeObserver[] = [];
  IntersectionObserver: unknown;
  CustomEvent = FakeCustomEvent;
  pageYOffset = 0;
  readonly scrolls: unknown[][] = [];
  readonly timers = new Map<number, { due: number; run: () => void }>();
  now = 0;
  lastTimer = 0;
  declare __bookingWidget?: boolean;
  declare BookingWidget?: FakeApi;
  constructor() {
    super();
    const observers = this.observers;
    this.IntersectionObserver = class extends FakeObserver {
      constructor(callback: ObserverCallback, options: unknown) {
        super(callback, options);
        observers.push(this);
      }
    };
  }
  getComputedStyle(node: FakeNode) {
    return { scrollMarginTop: node.scrollMargin };
  }
  matchMedia() {
    return { matches: false };
  }
  scrollTo(...args: unknown[]) {
    this.scrolls.push(args);
  }
  setTimeout(run: () => void, ms: number) {
    this.timers.set(++this.lastTimer, { due: this.now + ms, run });
    return this.lastTimer;
  }
  clearTimeout(timer: number) {
    this.timers.delete(timer);
  }
  tick(ms: number) {
    this.now += ms;
    for (const [timer, { due, run }] of [...this.timers]) {
      if (due > this.now || !this.timers.has(timer)) continue;
      this.timers.delete(timer);
      run();
    }
  }
}

const base = "https://booking.example.com";
const id = "3f0c9a52-8d1e-4b7a-9c26-5e4f1a2b3c4d";
const otherId = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const pageQuery = `?${widgetPageParam}=${encodeURIComponent("/pricing")}`;

function site(options: { currentScript?: boolean; scripts?: string[]; locale?: string; dialog?: boolean; observer?: boolean } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow();
  if (options.currentScript !== false) {
    doc.currentScript = doc.createElement("script");
    doc.currentScript.setAttribute("src", `${base}/widget.js`);
    if (options.locale) doc.currentScript.setAttribute("data-locale", options.locale);
  }
  for (const src of options.scripts ?? []) doc.head.appendChild(doc.createElement("script")).setAttribute("src", src);
  if (options.dialog === false) win.HTMLDialogElement = undefined;
  if (options.observer === false) win.IntersectionObserver = undefined;
  const load = () => runInNewContext(script, { window: win, document: doc, URL });
  load();
  const addButton = (attribute: string, href: string | null = `${base}/widget/${id}`) => {
    const link = doc.body.appendChild(doc.createElement("a"));
    link.setAttribute(widgetTriggerAttribute, attribute);
    if (href !== null) link.setAttribute("href", href);
    return link;
  };
  const click = (target: FakeNode, init: EventInit = {}) => win.emit(new FakeEvent("click", { target, ...init }));
  const dialogs = () => doc.body.children.filter((node): node is FakeDialog => node instanceof FakeDialog);
  return { doc, win, load, addButton, click, dialogs };
}

function opened(options: Parameters<typeof site>[0] = {}) {
  const page = site(options);
  const link = page.addButton(id);
  const event = page.click(link);
  const [dialog] = page.dialogs();
  const [close, frame] = dialog.children as [FakeNode, FakeFrame];
  const post = (data: unknown, origin = base, source: unknown = frame.contentWindow) => page.win.emit(new FakeEvent("message", { origin, source, data }));
  return { ...page, link, event, dialog, close, frame, post };
}

function section(options: { width?: number; observer?: boolean } = {}) {
  const page = site({ observer: options.observer });
  const api = page.win.BookingWidget!;
  const element = page.doc.body.appendChild(page.doc.createElement("div"));
  element.setAttribute(widgetSectionAttribute, id);
  element.clientWidth = options.width ?? 1100;
  const events: FakeCustomEvent[] = [];
  for (const type of [widgetBookedEvent, widgetUnavailableEvent]) page.doc.body.addEventListener(type, (event) => events.push(event as FakeCustomEvent));
  const frames = () => element.children.filter((node): node is FakeFrame => node instanceof FakeFrame);
  const post = (data: unknown, origin = base, source: unknown = frames()[0]?.contentWindow) => page.win.emit(new FakeEvent("message", { origin, source, data }));
  return { ...page, api, element, events, frames, post };
}

function readySection(prefill?: unknown) {
  const page = section({ observer: false });
  const handle = page.api.mount(page.element, prefill)!;
  const [frame] = page.frames();
  page.post(widgetMessage("ready"));
  return { ...page, handle, frame };
}

const prefillOf = (frame: FakeFrame) => frame.sent.at(-1)!.message as Record<string, unknown>;

describe("widget.js: loading", () => {
  it("attaches once, even when loaded twice, and offers a frozen v1 API", () => {
    const page = site();
    const api = page.win.BookingWidget;
    page.load();
    expect(page.win.__bookingWidget).toBe(true);
    expect(page.win.BookingWidget).toBe(api);
    expect(api?.v).toBe(1);
    expect(Object.isFrozen(api)).toBe(true);
    expect(page.win.listeners.get("click")).toHaveLength(1);
  });

  it("finds its own origin through the last /widget.js script when currentScript is missing", () => {
    const page = site({ currentScript: false, scripts: ["https://cdn.example.com/other.js", `${base}/widget.js?v=2`] });
    page.click(page.addButton(id));
    expect((page.dialogs()[0].children[1] as FakeFrame).src).toBe(`${base}${widgetPath(id, "window")}${pageQuery}`);
  });

  it("stays away without its own origin or without <dialog>, so the buttons remain links", () => {
    for (const page of [site({ currentScript: false }), site({ dialog: false })]) {
      expect(page.win.BookingWidget).toBeUndefined();
      expect(page.click(page.addButton(id)).defaultPrevented).toBe(false);
    }
  });
});

describe("widget.js: window", () => {
  it("opens a dialog with the X first and a frame to the widget with the page path, without sandbox", () => {
    const { event, dialog, close, frame, doc } = opened();
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe(en["widget.title"]);
    expect(close.getAttribute("aria-label")).toBe(en["widget.close"]);
    expect(doc.activeElement).toBe(close);
    expect(frame.src).toBe(`${base}/widget/${id}${pageQuery}`);
    expect(frame.getAttribute("referrerpolicy")).toBe("strict-origin");
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.head.children.filter((n) => n.hasAttribute("data-booking-widget-style"))).toHaveLength(1);
  });

  it("labels the dialog in German with data-locale=de", () => {
    const { dialog, close } = opened({ locale: "de" });
    expect(dialog.getAttribute("aria-label")).toBe(de["widget.title"]);
    expect(close.getAttribute("aria-label")).toBe(de["widget.close"]);
  });

  it("leaves modified, non-primary and foreign clicks alone", () => {
    const page = site();
    const link = page.addButton(id);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(page.click(link, init).defaultPrevented).toBe(false);
    }
    expect(page.click(page.addButton("", "https://evil.example/widget/" + id)).defaultPrevented).toBe(false);
    expect(page.dialogs()).toHaveLength(0);
    // A lowercase id from the link on this tool works without the attribute value.
    page.click(page.addButton("", `${base}/widget/${id.toUpperCase()}`));
    expect((page.dialogs()[0].children[1] as FakeFrame).src).toContain(`/widget/${id}?`);
  });

  it("reuses the dialog, and rebuilds it after the page path changed", () => {
    const page = opened();
    page.dialog.close();
    expect(page.doc.activeElement).toBe(page.link);
    expect(page.doc.body.style.overflow).toBe("auto");
    page.click(page.link);
    expect(page.dialogs()).toEqual([page.dialog]);
    page.dialog.close();
    page.win.location.pathname = "/about/";
    page.click(page.link);
    const [dialog] = page.dialogs();
    expect(dialog).not.toBe(page.dialog);
    expect((dialog.children[1] as FakeFrame).src).toBe(`${base}/widget/${id}?page=%2Fabout`);
  });

  it("falls back to the widget page when the dialog cannot open", () => {
    const page = site();
    page.doc.failModal = true;
    page.click(page.addButton(id));
    expect(page.win.location.href).toBe(`${base}/widget/${id}`);
    expect(page.doc.body.style.overflow).toBe("auto");
  });

  it("accepts messages only from the tool's origin and its own frame", () => {
    const page = opened();
    page.post(widgetMessage("ready"), "https://evil.example");
    page.post(widgetMessage("ready"), base, {});
    page.post({ ...widgetMessage("ready"), v: 2 });
    page.post({ ...widgetMessage("ready"), source: "other" });
    expect(page.frame.hasAttribute("data-ready")).toBe(false);
    page.post(widgetMessage("close"), "https://evil.example");
    expect(page.dialog.open).toBe(true);
    page.post(widgetMessage("ready"));
    expect(page.frame.hasAttribute("data-ready")).toBe(true);
    page.post(widgetMessage("close"));
    expect(page.dialog.open).toBe(false);
  });

  it("fits the card to the content height within the viewport", () => {
    const page = opened();
    page.post(widgetMessage("height", 500));
    expect(page.dialog.style.height).toBe("502px");
    page.post(widgetMessage("height", 5000));
    expect(page.dialog.style.height).toBe("868px");
    page.post(widgetMessage("height", 10));
    expect(page.dialog.style.height).toBe("200px");
  });

  it("closes on back", () => {
    const page = opened();
    page.win.emit(new FakeEvent("popstate"));
    expect(page.dialog.open).toBe(false);
  });
});

describe("widget.js: section", () => {
  it("mounts a lazy frame with a placeholder height and loads it near the viewport", () => {
    const page = section({ width: 1100 });
    const handle = page.api.mount(page.element, { name: "Ada" });
    expect(handle).not.toBeNull();
    const [frame] = page.frames();
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.style.height).toMatch(/^\d+px$/);
    expect(frame.getAttribute("scrolling")).toBe("no");
    expect(page.win.observers[0].options).toEqual({ rootMargin: "800px 0px" });
    page.win.observers[0].report(true);
    expect(frame.src).toBe(`${base}${widgetPath(id, "section")}${pageQuery}`);
    expect(page.win.observers[0].targets).toHaveLength(0);
    // Mount is idempotent per element.
    expect(page.api.mount(page.element)).toBe(handle);
    expect(page.frames()).toHaveLength(1);
  });

  it("returns null for an element without a valid id or outside the document, and never throws", () => {
    const page = section();
    page.element.setAttribute(widgetSectionAttribute, "nope");
    expect(page.api.mount(page.element)).toBeNull();
    expect(page.api.mount(page.doc.createElement("div"))).toBeNull();
    expect(page.api.mount(null)).toBeNull();
    expect(page.api.mount("x")).toBeNull();
    page.element.setAttribute(widgetSectionAttribute, id);
    const hostile = {
      get name() {
        throw new Error("boom");
      },
    };
    expect(page.api.mount(page.element, hostile)).not.toBeNull();
    expect(page.api.unmount({})).toBe(false);
  });

  it("sends the prefill only after ready, only to the tool's origin, and again after every ready", () => {
    const page = section({ observer: false });
    page.api.mount(page.element, { name: "Ada", email: "ada@example.com" });
    const [frame] = page.frames();
    expect(frame.sent).toEqual([]);
    page.post(widgetMessage("ready"), "https://evil.example");
    expect(frame.sent).toEqual([]);
    page.post(widgetMessage("ready"));
    expect(frame.sent).toEqual([
      { message: { source: "booking-widget", v: 1, type: "prefill", name: "Ada", email: "ada@example.com", company: "", topic: "", answers: [] }, target: base },
    ]);
    page.post(widgetMessage("ready"));
    expect(frame.sent).toHaveLength(2);
    expect(frame.sent.every((s) => s.target === base)).toBe(true);
    // Never into the URL or attributes.
    expect(frame.src).not.toContain("Ada");
    expect([...frame.attributes.values()].join(" ")).not.toContain("ada@");
  });

  it("updates the prefill through the handle", () => {
    const page = readySection({ name: "Ada" });
    page.handle.update({ name: "Grace", company: "Example Ltd" });
    expect(prefillOf(page.frame)).toMatchObject({ name: "Grace", company: "Example Ltd" });
  });

  it("cleans answers: valid ids, first per id, strings or string lists, at most 20; a question field is dropped", () => {
    const answers = [
      { id: "size", question: "How big?", answer: " 11-50 " },
      { id: "size", answer: "other" },
      { id: "tools", answer: ["A", " ", 3, "B"] },
      { id: "Bad", answer: "x" },
      { id: "empty", answer: "" },
      { id: "notes", answer: "line one\r\n\r\n\r\nline two" },
      null,
      ...Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, answer: "x" })),
    ];
    const sent = prefillOf(readySection({ answers }).frame).answers as { id: string; answer: unknown }[];
    expect(sent.slice(0, 3)).toEqual([
      { id: "size", answer: "11-50" },
      { id: "tools", answer: ["A", "B"] },
      { id: "notes", answer: "line one\n\nline two" },
    ]);
    expect(sent).toHaveLength(20);
    expect(prefillOf(readySection({ answers: "nope" }).frame).answers).toEqual([]);
  });

  it("cleans text like lib/core/questions.ts, character by character, within bookingInputLimits", () => {
    const characters = [...Array.from({ length: 0xa0 }, (_, i) => i), 0xad, 0x200b, 0x200e, 0x202e, 0x2028, 0x2029, 0x2060, 0x2066, 0xfeff, 0x1f600];
    for (const code of characters) {
      const c = String.fromCodePoint(code);
      const value = ` a${c}b ${c}\n${c}c `;
      const sent = prefillOf(readySection({ name: value, topic: value }).frame);
      expect(sent.name, `U+${code.toString(16)}`).toBe(cleanText(value, bookingInputLimits.name));
      expect(sent.topic, `U+${code.toString(16)}`).toBe(cleanMultiline(value, bookingInputLimits.topic));
    }
    const long = "x".repeat(5000);
    const sent = prefillOf(readySection({ name: long, email: long, company: long, topic: long, answers: [{ id: "a", answer: long }] }).frame);
    expect(sent).toMatchObject({
      name: cleanText(long, bookingInputLimits.name),
      email: cleanText(long, bookingInputLimits.email),
      company: cleanText(long, bookingInputLimits.company),
      topic: cleanMultiline(long, bookingInputLimits.topic),
      answers: [{ id: "a", answer: cleanMultiline(long, answerMaxLength) }],
    });
    expect(script).toContain(`name: ${bookingInputLimits.name}, email: ${bookingInputLimits.email}, company: ${bookingInputLimits.company}, topic: ${bookingInputLimits.topic}`);
    expect(script).toContain(`answer: ${answerMaxLength} }`);
  });

  it("grows with the reported height, clamped, and ignores close", () => {
    const page = readySection();
    page.post(widgetMessage("height", 640));
    expect(page.frame.style.height).toBe("640px");
    page.post({ source: "booking-widget", v: 1, type: "height", height: 1e9 });
    expect(page.frame.style.height).toBe(`${widgetMaxHeight}px`);
    page.post(widgetMessage("close"));
    expect(page.frames()).toHaveLength(1);
  });

  it("scrolls to the section's top on a step, minus scroll-margin-top, only when it is above the viewport", () => {
    const page = readySection();
    page.element.rect = { top: 10 };
    page.post(widgetMessage("top"));
    expect(page.win.scrolls).toEqual([]);
    page.element.rect = { top: -300 };
    page.element.scrollMargin = "64px";
    page.win.pageYOffset = 1000;
    page.post(widgetMessage("top"));
    expect(page.win.scrolls).toEqual([[{ top: 636, behavior: "smooth" }]]);
  });

  it("dispatches booked on the element, bubbling, without detail, only from its own frame and origin", () => {
    const page = readySection();
    page.post(widgetMessage("booked"), "https://evil.example");
    page.post(widgetMessage("booked"), base, {});
    expect(page.events).toEqual([]);
    page.post(widgetMessage("booked"));
    expect(page.events.map((e) => [e.type, e.bubbles, e.detail])).toEqual([[widgetBookedEvent, true, null]]);
  });

  it("gives up after the ready timeout: removes the frame and dispatches unavailable", () => {
    const page = section({ observer: false });
    page.api.mount(page.element);
    page.win.tick(widgetReadyTimeout - 1);
    expect(page.events).toEqual([]);
    page.win.tick(1);
    expect(page.frames()).toEqual([]);
    expect(page.events.map((e) => [e.type, e.bubbles, e.detail])).toEqual([[widgetUnavailableEvent, true, null]]);
    // A ready in time stops the timer.
    const ready = readySection();
    ready.win.tick(widgetReadyTimeout * 2);
    expect(ready.events).toEqual([]);
    expect(ready.frames()).toHaveLength(1);
  });

  it("unmounts, rebuilds for another id and prunes sections the page removed", () => {
    const page = readySection();
    expect(page.api.unmount(page.element)).toBe(true);
    expect(page.frames()).toEqual([]);
    expect(page.api.unmount(page.element)).toBe(false);
    page.api.mount(page.element);
    page.element.setAttribute(widgetSectionAttribute, otherId);
    page.api.mount(page.element);
    expect(page.frames()).toHaveLength(1);
    expect(page.frames()[0].src).toContain(`/widget/${otherId}/section`);
    page.frames()[0].remove();
    page.api.mount(page.element);
    expect(page.frames()).toHaveLength(1);
    page.handle.unmount();
  });
});

describe("widget.js: booking page", () => {
  it("sends only a clean path, like cleanWidgetPage", () => {
    for (const path of ["/", "/pricing/", "/a/b.html", "/ä", "/p?x", 42, `/${"a".repeat(250)}`]) {
      const page = site();
      page.win.location.pathname = path;
      page.click(page.addButton(id));
      const clean = cleanWidgetPage(path);
      expect((page.dialogs()[0].children[1] as FakeFrame).src).toBe(`${base}/widget/${id}${clean ? `?page=${encodeURIComponent(clean)}` : ""}`);
    }
  });
});
