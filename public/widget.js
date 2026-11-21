/* Booking widget loader for host websites: a window (dialog) over the page, or a section inline in the page.
 *
 * Window: load this script once with defer, then add one link per button:
 *   <a href="APP_URL/widget/ID" data-booking-widget="ID">Book a time</a>
 * A plain click opens the booking in a dialog: a card at most 480px wide and as tall as its content, the full screen
 * below 808px. Without the script, and with Ctrl, Cmd, Shift, Alt or middle click, the link opens the widget page.
 *
 * Section: the same script, plus an empty <div data-booking-section="ID"> on which the page calls
 *   window.BookingWidget.mount(element, { name, email, company, topic, answers: [{ id, answer }] })
 * The booking fills the element's width and grows with its content; it loads when the element comes near the viewport.
 * The prefill is cleaned and goes only by postMessage to the tool's own origin, never into a URL, attribute or storage.
 * On each booking step the section's top scrolls into view. The element receives "booking-widget:booked" after a
 * booking and "booking-widget:unavailable" when no "ready" arrived within 15 seconds of loading (blocked, switched off
 * or unreachable); both bubble and carry no detail. On "unavailable" the page should show a plain booking link instead.
 *
 * Both frames get the host page's path (location.pathname only) as ?page=, so the tool records where a booking came
 * from. data-locale="de" or "en" on the script tag picks the language of the dialog's labels (default en).
 *
 * Hand-written classic script in ES2019, no build step. It touches nothing the page owns: it adds one <dialog> per
 * widget to body, one <style> to head and one iframe per section. No cookies, no storage, no requests besides the
 * frames, no tracking. Colors and fonts come from CSS variables (--booking-widget-*) with neutral fallbacks.
 * Protocol v1 and the limits match lib/core/widget.ts, lib/core/booking.ts and lib/core/questions.ts;
 * tests/unit/widget-loader.test.ts checks that.
 */
(function () {
  "use strict";

  if (window.__bookingWidget) return;

  // The tool's origin, taken from this script's own URL: the frames point only there and only messages from there count.
  // Without <dialog> support the buttons stay plain links.
  const script = ownScript();
  const base = originOf(script);
  const Dialog = window.HTMLDialogElement;
  if (!base || typeof Dialog !== "function" || !("showModal" in Dialog.prototype)) return;
  window.__bookingWidget = true;
  // The section API (BookingWidgetApi in lib/core/widget.ts). Missing (no script, an old cached copy, no <dialog>):
  // the page shows its plain booking link.
  window.BookingWidget = Object.freeze({ v: 1, mount: mount, unmount: unmount });

  const triggerAttribute = "data-booking-widget"; // widgetTriggerAttribute
  const sectionAttribute = "data-booking-section"; // widgetSectionAttribute
  const messageSource = "booking-widget"; // widgetMessageSource
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const idPattern = new RegExp("^" + uuid + "$", "i");
  const pathPattern = new RegExp("^/widget/(" + uuid + ")/?$", "i");
  const wide = 808; // from here a card, below it the full screen
  const gap = 32; // space around the card, top and bottom together
  const minHeight = 200;
  const hairlines = 2; // the card's border, top and bottom
  const bookedEvent = "booking-widget:booked"; // widgetBookedEvent
  const unavailableEvent = "booking-widget:unavailable"; // widgetUnavailableEvent
  const readyTimeout = 15000; // widgetReadyTimeout
  const nearMargin = "800px 0px"; // a section loads when it comes this close to the viewport
  const maxHeight = 10000; // widgetMaxHeight
  // bookingInputLimits (lib/core/booking.ts), answerMaxLength and the question id rule (lib/core/questions.ts, at most
  // 20 questions per event type).
  const limits = { name: 200, email: 254, company: 200, topic: 2000, pairs: 20, choices: 30, answer: 500 };
  const answerPattern = /^[a-z][a-z0-9_-]{0,39}$/;
  // Space for a section until the booking reports its height: from 900px element width the two-column layout, below it
  // one column. The first height the booking reports in the e2e embed page, rounded up to 10px.
  const twoColumns = 900;
  const placeholderWide = 760;
  const placeholderNarrow = 1350;
  // Like cleanText in lib/core/questions.ts: invisible characters go, other control characters become spaces.
  const invisible = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
  const control = /[\u0000-\u001f\u007f-\u009f]/g;
  // widgetPageParam, widgetPageMax and cleanWidgetPage in lib/core/widget.ts.
  const pageParam = "page";
  const pageMax = 200;
  const pagePattern = /^\/[A-Za-z0-9/_.-]*$/;
  // widget.title and widget.close in messages/*.json.
  const strings = {
    en: { dialog: "Book a time", close: "Close" },
    de: { dialog: "Termin buchen", close: "Schließen" },
  };
  const text = strings[script && script.getAttribute && script.getAttribute("data-locale") === "de" ? "de" : "en"];
  const closeIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5l11 11"></path><path d="M17.5 6.5l-11 11"></path></svg>';

  // Host pages often reset dialog defaults (CSS frameworks, @layer base). So every property is written out, without
  // @layer (which puts it above any layer of the page), and only under dialog[data-booking-widget-window] and
  // [data-booking-section] > iframe.
  const css = `
    dialog[data-booking-widget-window] {
      position: fixed;
      inset: 0;
      box-sizing: border-box;
      width: min(480px, calc(100vw - 32px));
      height: min(720px, calc(100vh - 32px));
      height: min(720px, calc(100dvh - 32px));
      min-width: 0;
      min-height: 0;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px);
      max-height: calc(100dvh - 32px);
      margin: auto;
      padding: 0;
      overflow: hidden;
      border: 1px solid var(--booking-widget-border, #c9c9c9);
      border-radius: var(--booking-widget-radius, 12px);
      background: var(--booking-widget-surface, #fff);
      box-shadow: var(--booking-widget-shadow, 0 18px 40px -18px rgba(0, 0, 0, 0.25));
      color: var(--booking-widget-text, #1a1a1a);
      font: 400 1rem/1.5 var(--booking-widget-font, system-ui, sans-serif);
      color-scheme: light;
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }
    dialog[data-booking-widget-window]:not([open]) { display: none; }
    dialog[data-booking-widget-window][open] { display: block; }
    dialog[data-booking-widget-window]:focus { outline: none; }
    dialog[data-booking-widget-window]::backdrop {
      position: fixed;
      inset: 0;
      margin: 0;
      padding: 0;
      border: 0;
      background: var(--booking-widget-backdrop, rgba(0, 0, 0, 0.45));
      pointer-events: auto;
    }
    /* The X sits over the right end of the widget's header: a 44px target, 6px from the edge. */
    dialog[data-booking-widget-window] > button {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 1;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      min-width: 0;
      min-height: 0;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--booking-widget-text, #1a1a1a);
      font: inherit;
      cursor: pointer;
      -webkit-appearance: none;
      appearance: none;
      box-shadow: none;
      opacity: 1;
      transform: none;
    }
    dialog[data-booking-widget-window] > button:hover { background: var(--booking-widget-hover, #f0f0f0); }
    dialog[data-booking-widget-window] > button:focus:not(:focus-visible) { outline: none; }
    dialog[data-booking-widget-window] > button:focus-visible {
      outline: 3px solid var(--booking-widget-focus, #1f4fd1);
      outline-offset: 2px;
    }
    dialog[data-booking-widget-window] > button > svg {
      display: block;
      flex: none;
      width: 20px;
      height: 20px;
      margin: 0;
      fill: none;
      stroke: currentColor;
      pointer-events: none;
    }
    dialog[data-booking-widget-window] > iframe {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      max-width: none;
      max-height: none;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    @media (prefers-reduced-motion: no-preference) {
      dialog[data-booking-widget-window][open] { animation: booking-widget-in 200ms cubic-bezier(0.16, 1, 0.3, 1); }
      dialog[data-booking-widget-window][open]::backdrop { animation: booking-widget-backdrop-in 200ms cubic-bezier(0.16, 1, 0.3, 1); }
    }
    @keyframes booking-widget-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
    @keyframes booking-widget-backdrop-in { from { opacity: 0; } }
    /* Phones and narrow windows: the full screen without corners or shadow; the script's height does not apply. The
       device's safe areas stay free, and the X moves with them. */
    @media (max-width: 807px) {
      dialog[data-booking-widget-window] {
        inset: 0;
        width: 100vw;
        height: 100vh !important;
        height: 100dvh !important;
        max-width: none;
        max-height: none;
        margin: 0;
        padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      dialog[data-booking-widget-window] > button {
        top: calc(6px + env(safe-area-inset-top, 0px));
        right: calc(6px + env(safe-area-inset-right, 0px));
      }
    }
    /* Section: the frame fills the element's width, without border or background; the script sets its height. */
    [data-booking-section] > iframe {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: none;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color-scheme: light;
    }
  `;

  const dialogs = Object.create(null); // one window per widget until the page reloads
  const sections = []; // one section per element until the page unmounts or removes it
  let style = null;

  // One capturing listener for all buttons, including those a framework renders later.
  window.addEventListener("click", onClick, true);
  window.addEventListener("message", onMessage);
  window.addEventListener("popstate", closeAll);
  window.addEventListener("resize", fitAll);

  // Only a plain primary click opens the window. The click still reaches the page's own listeners (no
  // stopPropagation); only the navigation is prevented.
  function onClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    let target = event.target;
    if (target && target.nodeType === 3) target = target.parentNode;
    const element = target && typeof target.closest === "function" ? target.closest("[" + triggerAttribute + "]") : null;
    const id = element ? widgetId(element) : null;
    if (!id) return;
    event.preventDefault();
    open(id, element);
  }

  // The widget id: the attribute's value, else from the link when it points to /widget/ID on this tool.
  function widgetId(element) {
    const value = (element.getAttribute(triggerAttribute) || "").trim();
    if (idPattern.test(value)) return value.toLowerCase();
    const href = element.getAttribute("href");
    if (!href) return null;
    try {
      const url = new URL(href, document.baseURI);
      const match = url.origin === base ? pathPattern.exec(url.pathname) : null;
      return match ? match[1].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  // The first click builds dialog and frame; later clicks show the same dialog again, so the visitor continues where they
  // were. If the page removed the dialog or changed its path without a reload, it is built again so the page is right.
  function open(id, element) {
    ensureStyle();
    let entry = dialogs[id];
    if (entry && entry.dialog.isConnected && entry.dialog.open) return;
    const page = pageQuery();
    if (!entry || !entry.dialog.isConnected || entry.page !== page) {
      // Removed while open: no "close" came, so body gets its overflow back here.
      if (entry && entry.locked) unlock(entry);
      if (entry && entry.dialog.isConnected) entry.dialog.remove();
      entry = dialogs[id] = build(id, page);
    }
    entry.trigger = element;
    // Still locked when the last close event is pending; then the remembered overflow stays.
    if (!entry.locked) {
      entry.overflow = document.body.style.overflow;
      entry.locked = true;
    }
    document.body.style.overflow = "hidden";
    try {
      entry.dialog.showModal();
    } catch {
      // The dialog cannot open: go to the widget page as without the script.
      unlock(entry);
      window.location.href = base + "/widget/" + id;
    }
  }

  function unlock(entry) {
    document.body.style.overflow = entry.overflow;
    entry.locked = false;
  }

  // Content in this order: the X (focused on open), then the frame.
  function build(id, page) {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("data-booking-widget-window", "");
    dialog.setAttribute("aria-label", text.dialog);

    const close = document.createElement("button");
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", text.close);
    close.setAttribute("autofocus", "");
    close.innerHTML = closeIcon;

    const frame = document.createElement("iframe");
    frame.setAttribute("title", text.dialog);
    // The page's origin as referrer even if it sends none otherwise: Firefox has no location.ancestorOrigins, and the
    // widget needs the parent origin to know where it may post.
    frame.setAttribute("referrerpolicy", "strict-origin");
    frame.setAttribute("src", base + "/widget/" + id + page);

    dialog.appendChild(close);
    dialog.appendChild(frame);

    const entry = { dialog: dialog, frame: frame, page: page, trigger: null, overflow: "", locked: false, height: null };

    // The second click of a double click on the button lands in the dialog already; it does not close it again.
    close.addEventListener("click", function (event) {
      if (event.detail <= 1) dialog.close();
    });
    // A click on the backdrop targets the dialog itself; clicks in the card hit the X or the frame.
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog && event.detail <= 1) dialog.close();
    });
    // Escape closes through the dialog's default (cancel, then close); with focus in the frame the widget posts "close".
    // Focus then returns to the button. The close event comes a moment later; if the dialog is open again by then, it
    // is stale.
    dialog.addEventListener("close", function () {
      if (dialog.open) return;
      if (entry.locked) unlock(entry);
      const element = entry.trigger && entry.trigger.isConnected ? entry.trigger : firstTrigger(id);
      if (element && typeof element.focus === "function") element.focus({ preventScroll: true });
    });

    document.body.appendChild(dialog);
    return entry;
  }

  // If the page re-rendered the remembered button, the first button with the same id gets the focus.
  function firstTrigger(id) {
    const elements = document.querySelectorAll("[" + triggerAttribute + "]");
    for (let i = 0; i < elements.length; i++) {
      if (widgetId(elements[i]) === id) return elements[i];
    }
    return null;
  }

  // Messages from the widget (widgetMessage in lib/core/widget.ts): only from the tool's origin and only from one of our
  // own frames; everything else is ignored. Windows know ready, close and height; sections have their own branch.
  function onMessage(event) {
    if (event.origin !== base) return;
    const section = sectionFor(event.source);
    if (section) {
      onSectionMessage(section, event.data);
      return;
    }
    const entry = entryFor(event.source);
    const data = event.data;
    if (!entry || !data || typeof data !== "object" || data.source !== messageSource || data.v !== 1) return;
    if (data.type === "ready") {
      entry.frame.setAttribute("data-ready", "");
    } else if (data.type === "close") {
      if (entry.dialog.open) entry.dialog.close();
    } else if (data.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) {
      entry.height = data.height;
      fit(entry);
    }
  }

  function entryFor(source) {
    if (!source) return null;
    const ids = Object.keys(dialogs);
    for (let i = 0; i < ids.length; i++) {
      if (dialogs[ids[i]].frame.contentWindow === source) return dialogs[ids[i]];
    }
    return null;
  }

  // The card's height: the widget's content plus border, at most the viewport minus 32px (beyond that the frame scrolls),
  // at least 200px. Below 808px the dialog fills the screen and only the CSS applies.
  function fit(entry) {
    if (entry.height === null || window.innerWidth < wide) return;
    const height = Math.max(minHeight, Math.min(entry.height + hairlines, window.innerHeight - gap));
    entry.dialog.style.height = height + "px";
  }

  function fitAll() {
    Object.keys(dialogs).forEach(function (id) {
      fit(dialogs[id]);
    });
  }

  // Back in the browser closes an open window; the page handles its own navigation.
  function closeAll() {
    Object.keys(dialogs).forEach(function (id) {
      if (dialogs[id].dialog.open) dialogs[id].dialog.close();
    });
  }

  // Sections ------------------------------------------------------------------------------------------------------------
  // Clicks, back, resize, Escape and "close" concern windows only. No MutationObserver: a section exists only through
  // mount, so the page's hydration stays untouched.

  // Builds the booking into an element of the page and returns a handle with update and unmount; null when the element
  // is not in the document or has no valid id. One section per element: a second call returns the same handle and only
  // takes the new prefill; if the element now has another id, the section is rebuilt (none for an invalid id). Sections
  // whose element or frame the page removed without unmount are cleaned up first. Never throws.
  function mount(element, prefill) {
    let built = null;
    try {
      prune();
      const id = sectionId(element);
      const entry = sectionOf(element);
      if (entry && entry.id === id) {
        entry.prefill = clean(prefill);
        sendPrefill(entry);
        return entry.handle;
      }
      if (entry) remove(entry);
      if (!id) return null;
      built = buildSection(element, id, clean(prefill));
      watch(built);
      return built.handle;
    } catch {
      if (built) remove(built);
      return null;
    }
  }

  // Removes the section: timer, observer and frame. The element belongs to the page and stays; true if there was one.
  function unmount(element) {
    const entry = sectionOf(element);
    if (!entry) return false;
    remove(entry);
    return true;
  }

  function sectionId(element) {
    if (!element || element.nodeType !== 1 || !element.isConnected) return null;
    const value = (element.getAttribute(sectionAttribute) || "").trim();
    return idPattern.test(value) ? value.toLowerCase() : null;
  }

  function sectionOf(element) {
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].element === element) return sections[i];
    }
    return null;
  }

  function sectionFor(source) {
    if (!source) return null;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].frame.contentWindow === source) return sections[i];
    }
    return null;
  }

  // The frame becomes the element's only child, first without src (nothing loads yet) and as tall as the placeholder.
  // Like the window: no sandbox or allow, the page's origin as referrer, and scrolling="no" since it grows with its content.
  function buildSection(element, id, prefill) {
    ensureStyle();
    const frame = document.createElement("iframe");
    frame.setAttribute("title", text.dialog);
    frame.setAttribute("referrerpolicy", "strict-origin");
    frame.setAttribute("scrolling", "no");
    frame.style.height = (element.clientWidth >= twoColumns ? placeholderWide : placeholderNarrow) + "px";
    const entry = { element: element, id: id, page: pageQuery(), frame: frame, observer: null, timer: null, prefill: prefill, ready: false, handle: null };
    entry.handle = Object.freeze({
      update: function (next) {
        if (sections.indexOf(entry) < 0) return;
        entry.prefill = clean(next);
        sendPrefill(entry);
      },
      unmount: function () {
        if (sections.indexOf(entry) >= 0) remove(entry);
      },
    });
    element.appendChild(frame);
    sections.push(entry);
    return entry;
  }

  // The booking loads when the section comes within 800px of the viewport; at once without IntersectionObserver.
  function watch(entry) {
    const Observer = window.IntersectionObserver;
    if (typeof Observer !== "function") {
      load(entry);
      return;
    }
    entry.observer = new Observer(
      function (records) {
        for (let i = 0; i < records.length; i++) {
          if (records[i].isIntersecting) {
            disconnect(entry);
            load(entry);
            return;
          }
        }
      },
      { rootMargin: nearMargin },
    );
    entry.observer.observe(entry.element);
  }

  // Setting src starts the timer: a frame that reports no "ready" by then (blocked by frame-ancestors, switched off or
  // unreachable) makes the section unavailable.
  function load(entry) {
    if (sections.indexOf(entry) < 0 || entry.frame.hasAttribute("src")) return;
    entry.frame.setAttribute("src", base + "/widget/" + entry.id + "/section" + entry.page);
    entry.timer = window.setTimeout(function () {
      expire(entry);
    }, readyTimeout);
  }

  // Unavailable: remove the section (a later mount builds it again) and tell the element, without detail.
  function expire(entry) {
    entry.timer = null;
    if (sections.indexOf(entry) < 0) return;
    remove(entry);
    entry.element.dispatchEvent(new window.CustomEvent(unavailableEvent, { bubbles: true }));
  }

  function remove(entry) {
    stopTimer(entry);
    disconnect(entry);
    entry.frame.remove();
    const index = sections.indexOf(entry);
    if (index >= 0) sections.splice(index, 1);
  }

  // Also cleaned up when the page took only the frame out of the element; mount would otherwise return a dead handle.
  function prune() {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (!sections[i].element.isConnected || sections[i].frame.parentNode !== sections[i].element) remove(sections[i]);
    }
  }

  function stopTimer(entry) {
    if (entry.timer === null) return;
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }

  function disconnect(entry) {
    if (!entry.observer) return;
    entry.observer.disconnect();
    entry.observer = null;
  }

  // Messages from a section's frame: ready (then the prefill goes over), height, top and booked. close and anything else
  // are ignored.
  function onSectionMessage(entry, data) {
    if (!data || typeof data !== "object" || data.source !== messageSource || data.v !== 1) return;
    if (data.type === "ready") {
      entry.frame.setAttribute("data-ready", "");
      entry.ready = true;
      stopTimer(entry);
      sendPrefill(entry);
    } else if (data.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) {
      // As tall as the content at any width, with no cap at the viewport: only the page scrolls.
      if (data.height > 0) entry.frame.style.height = Math.min(maxHeight, data.height) + "px";
    } else if (data.type === "top") {
      toStart(entry.element);
    } else if (data.type === "booked") {
      entry.element.dispatchEvent(new window.CustomEvent(bookedEvent, { bubbles: true }));
    }
  }

  // The prefill goes over only after "ready" (nobody listens before), again after every new "ready" (the frame
  // reloaded), and only to the tool's origin.
  function sendPrefill(entry) {
    const view = entry.ready ? entry.frame.contentWindow : null;
    if (!view) return;
    const prefill = entry.prefill;
    const message = {
      source: messageSource,
      v: 1,
      type: "prefill",
      name: prefill.name,
      email: prefill.email,
      company: prefill.company,
      topic: prefill.topic,
      answers: prefill.answers,
    };
    try {
      view.postMessage(message, base);
    } catch {
      // Not delivered: the invitee fills in the form themselves.
    }
  }

  // To the top (on each booking step), only when the section's top is above the viewport; a fixed header of the page
  // counts through the element's scroll-margin-top. Jumps with reduced motion, glides otherwise. Not scrollIntoView,
  // which would take the page's scroll-padding-top along. Focus stays in the frame.
  function toStart(element) {
    const computed = window.getComputedStyle(element);
    const margin = (computed && parseFloat(computed.scrollMarginTop)) || 0;
    const top = element.getBoundingClientRect().top;
    if (top >= margin - 1) return;
    const y = window.pageYOffset + top - margin;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      window.scrollTo({ top: y, behavior: reduce ? "instant" : "smooth" });
    } catch {
      window.scrollTo(0, y); // older browsers know neither the object form nor "instant"
    }
  }

  // The page's prefill, cleaned like the booking form (cleanBookingInput, cleanText and cleanMultiline): a new flat
  // object of strings, so postMessage never fails on functions or nodes and nothing else goes along. Answers: at most 20
  // pairs { id, answer } with a valid question id, first one per id wins; answer a string or, for multi questions, a
  // list of strings. The tool checks them against the event type's questions. Never throws: if the prefill cannot be
  // read (a getter throws), it is empty.
  function clean(prefill) {
    try {
      const raw = prefill && typeof prefill === "object" ? prefill : {};
      return {
        name: cleanText(raw.name, limits.name),
        email: cleanText(raw.email, limits.email),
        company: cleanText(raw.company, limits.company),
        topic: cleanMultiline(raw.topic, limits.topic),
        answers: cleanAnswers(raw.answers),
      };
    } catch {
      return { name: "", email: "", company: "", topic: "", answers: [] };
    }
  }

  function cut(value, max) {
    return Array.from(value).slice(0, max).join("").trim();
  }

  function cleanText(value, max) {
    if (typeof value !== "string") return "";
    return cut(value.replace(invisible, "").replace(control, " ").replace(/\s+/g, " ").trim(), max);
  }

  function cleanMultiline(value, max) {
    if (typeof value !== "string") return "";
    const result = value
      .replace(invisible, "")
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cut(result, max);
  }

  // Array.isArray, because the list may come from another window.
  function cleanAnswers(input) {
    const answers = [];
    if (!Array.isArray(input)) return answers;
    const seen = new Set();
    for (const item of input.slice(0, limits.pairs * 5)) {
      if (answers.length >= limits.pairs) break;
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!answerPattern.test(id) || seen.has(id)) continue;
      const answer = Array.isArray(item.answer)
        ? item.answer
            .slice(0, limits.choices)
            .map(function (choice) {
              return cleanText(choice, limits.answer);
            })
            .filter(Boolean)
        : cleanMultiline(item.answer, limits.answer);
      if (!answer.length) continue;
      seen.add(id);
      answers.push({ id: id, answer: answer });
    }
    return answers;
  }

  // The booking page as the frame URL's search part, read when the frame is built: "?page=%2Fpricing", or empty when the
  // path does not fit. Only the path; the page's search and hash never go along.
  function pageQuery() {
    try {
      const page = cleanPage(window.location.pathname);
      return page ? "?" + pageParam + "=" + encodeURIComponent(page) : "";
    } catch {
      return "";
    }
  }

  function cleanPage(value) {
    if (typeof value !== "string") return null;
    let end = value.length;
    while (end > 1 && value.charAt(end - 1) === "/") end--;
    const path = value.slice(0, end);
    return path.length <= pageMax && pagePattern.test(path) ? path : null;
  }

  // One <style> for all windows and sections, added on the first open or mount; added again if the page re-rendered head.
  function ensureStyle() {
    if (style && style.isConnected) return;
    style = document.createElement("style");
    style.setAttribute("data-booking-widget-style", "");
    style.textContent = css;
    document.head.appendChild(style);
  }

  // document.currentScript, else the last script whose URL ends in /widget.js.
  function ownScript() {
    if (document.currentScript && document.currentScript.src) return document.currentScript;
    const scripts = document.getElementsByTagName("script");
    for (let i = scripts.length - 1; i >= 0; i--) {
      if (/\/widget\.js(?:[?#]|$)/.test(scripts[i].src || "")) return scripts[i];
    }
    return null;
  }

  function originOf(element) {
    try {
      return element ? new URL(element.src).origin : null;
    } catch {
      return null;
    }
  }
})();
