import { describe, expect, it } from "vitest";
import { composeMail, oneLine } from "./compose";

describe("composeMail", () => {
  it("drops missing lines and empty paragraphs, and keeps text and HTML in step", () => {
    const mail = composeMail([["Hello Ada,"], [null, false], ["When: Monday", null, "Video call: https://meet.example.com/abc"], [undefined]]);
    expect(mail.text).toBe("Hello Ada,\n\nWhen: Monday\nVideo call: https://meet.example.com/abc");
    expect(mail.html).toContain("<p>Hello Ada,</p>\n<p>When: Monday<br>Video call: <a href=\"https://meet.example.com/abc\">https://meet.example.com/abc</a></p>");
  });

  it("escapes invitee text before linking, so it never becomes markup", () => {
    const { text, html } = composeMail([["Topic: <script>alert(1)</script> & \"x\" 'y'"], ['See "https://evil.example.com/"onmouseover="alert(1)'], ["javascript:alert(1)"]]);
    expect(text).toContain("<script>");
    expect(html).not.toMatch(/<script|onmouseover="/);
    expect(html).toContain("Topic: &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &#39;y&#39;");
    // The quote stays an entity inside the href, so the attribute is never closed.
    expect(html).toContain('<a href="https://evil.example.com/&quot;onmouseover=&quot;alert(1)">');
    expect(html).not.toContain('href="javascript');
  });

  it("keeps line breaks inside a value", () => {
    expect(composeMail([["Reason: first\nsecond"]]).html).toContain("<p>Reason: first<br>second</p>");
  });
});

describe("oneLine", () => {
  it("removes line breaks from subjects", () => {
    expect(oneLine("New booking: Ada\r\nBcc: someone@example.com\u2028x ")).toBe("New booking: Ada Bcc: someone@example.com x");
  });
});
