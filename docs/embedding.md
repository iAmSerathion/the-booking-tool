# Embedding booking widgets

A widget puts booking on another website: as a **window** (a dialog over the page, opened by a button) or as a
**section** (inline in the page, as wide as its container and as tall as its content). Below, `APP_URL` is the address
of your instance and `ID` the widget's id.

## 1. Create a widget

In the admin, open **Widgets** (admins only) and fill in:

- **Name**, for you.
- **Event type**: what invitees book.
- **Bookings go to**: one person, or round robin over the people you choose (the free person whose last booking from a
  website is oldest gets it).
- **Allowed sites**: the origins that may embed the widget, one per line, for example `https://www.example.com`. No
  path; https only (plain http only for `localhost` and `127.0.0.1`); at most 20. `https://example.com` and
  `https://www.example.com` are different sites. A widget without sites of its own uses `EMBED_ALLOWED_ORIGINS`.

Switch a widget off to stop bookings at once. Under **Embed code** each widget shows its two snippets with the right
`APP_URL` and id. **Playground** (admins, or any member under `next dev`) lets you try a widget with a prefill before
you embed it.

## 2. Window

```html
<script src="APP_URL/widget.js" data-locale="en" defer></script>
<a href="APP_URL/widget/ID" data-booking-widget="ID">Book a time</a>
```

Load the script once per page; add as many buttons as you like. A plain click opens the dialog; without the script, or
with Ctrl, Cmd, Shift, Alt or a middle click, the link opens the booking page itself. `data-locale` (`en` or `de`, default `en`)
sets the language of the dialog's labels. Style the button as you like; the link text is yours.

## 3. Section

```html
<script src="APP_URL/widget.js" data-locale="en" defer></script>
<div data-booking-section="ID"></div>
<script>
  addEventListener("DOMContentLoaded", function () {
    var element = document.querySelector('[data-booking-section="ID"]');
    if (window.BookingWidget) window.BookingWidget.mount(element, {});
  });
</script>
```

`window.BookingWidget.mount(element, prefill)` returns a handle with `update(prefill)` and `unmount()`, or `null` when
the element has no valid id. `window.BookingWidget.unmount(element)` removes the section again. Single-page apps call
`mount` when the element is in the DOM and `unmount` before it goes away. The section loads when it comes near the
viewport and on each booking step scrolls its top back into view when it is above the viewport; give the element
`scroll-margin-top` if a fixed header covers it.

### Prefill

What your site already knows can be passed on, all fields optional:

```js
window.BookingWidget.mount(element, {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Example Ltd",
  topic: "Pricing for ten seats",
  answers: [{ id: "topic", answer: "Pricing" }], // the event type's question ids; a string list for multi questions
});
```

The prefill goes only by `postMessage` to `APP_URL`, never into a URL, attribute or storage, and only after the widget
has answered from a verified frame. The invitee can change every field; the server checks everything again.

## 4. Events

The section element receives two events. Both bubble and carry no detail (no invitee data reaches your page):

- `booking-widget:booked`: a booking was made.
- `booking-widget:unavailable`: the widget did not answer within 15 seconds (switched off, your site is not allowed,
  or the instance is unreachable).

## 5. Fallback

Show a plain link to `APP_URL/widget/ID` when `window.BookingWidget` is missing, `mount` returns `null`, or after
`booking-widget:unavailable`.

## 6. Where bookings came from

Both views send the path of your page (`location.pathname`, never the query or hash) along; the booking stores it with
your origin, for example `https://www.example.com/pricing`.

## 7. Styling

The dialog uses CSS variables with neutral defaults; set them on `:root` of your page:
`--booking-widget-surface`, `--booking-widget-text`, `--booking-widget-border`, `--booking-widget-backdrop`,
`--booking-widget-focus`, `--booking-widget-hover`, `--booking-widget-shadow`, `--booking-widget-radius`,
`--booking-widget-font`.

## 8. Your site's Content Security Policy

If your site sends a CSP, allow the instance: `script-src APP_URL` and `frame-src APP_URL`.

## Troubleshooting

- **Blank frame or browser error page in the window, `booking-widget:unavailable` in a section**: your origin is not
  among the widget's allowed sites (check scheme, `www` and port), or the widget is switched off. The instance sends
  `Content-Security-Policy: frame-ancestors` with exactly the allowed sites, and `'none'` for a switched-off or unknown
  widget.
- **"Booking here is not possible right now"** shows only when the widget page is opened directly while the widget is
  off, its event type is off or nobody can be booked.
