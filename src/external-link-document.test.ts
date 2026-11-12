import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { externalLinkDocument } from "./external-link-document";

test("local external-link document matches expressive layout with OS themes and fixed controls", () => {
  const html = externalLinkDocument("https://example.com:8443/documentation");
  for (const text of ["Открыть в браузере?", "Открыть в браузере", "Отмена", "example.com:8443",
    'id="external-close"', 'id="external-cancel"', 'id="external-open"', 'dir="ltr"',
    "prefers-color-scheme: dark", "overflow-wrap: anywhere", "overflow: auto", "hero-icon"]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<bdi[^>]*>example\.com:8443<\/bdi>/);
  assert.match(html, /id="external-destination"[^>]*tabindex="0"/);
  assert.doesNotMatch(html, /<(?:a|script|iframe|img)\b|\bon\w+=|\b(?:src|href)=/i);
});

test("strict CSP permits only the exact embedded stylesheet and no scripts or remote resources", () => {
  const html = externalLinkDocument("https://example.com/");
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(style);
  const digest = createHash("sha256").update(style).digest("base64");
  for (const directive of ["default-src 'none'", "script-src 'none'", "base-uri 'none'", "form-action 'none'",
    `style-src 'sha256-${digest}'`]) assert.ok(html.includes(directive), directive);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|https:\/\/[^<]*\.css/);
});

test("muted text and close icon retain accessible contrast in both OS themes with pressed feedback", () => {
  const html = externalLinkDocument("https://example.com/");
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]; assert.ok(style);
  const light = style.split("@media")[0]; const dark = style.split("@media")[1]; assert.ok(light && dark);
  const luminance = (hex: string) => {
    const expanded = hex.length === 4 ? `#${[...hex.slice(1)].map((value) => value + value).join("")}` : hex;
    const channel = (offset: number) => {
      const value = Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
  };
  const ratio = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
    const high = values[0]; const low = values[1]; assert.ok(high !== undefined && low !== undefined);
    return (high + 0.05) / (low + 0.05);
  };
  for (const [css, selector, background, minimum] of [
    [light, "description", "#ffffff", 4.5], [light, "url", "#f5f6f9", 4.5],
    [light, "note", "#ffffff", 4.5], [light, "close", "#ffffff", 3],
    [dark, "description", "#23262f", 4.5], [dark, "url", "#2c303b", 4.5],
    [dark, "note", "#23262f", 4.5],
  ]) {
    assert.ok(typeof css === "string" && typeof selector === "string" && typeof background === "string" && typeof minimum === "number");
    const rule = css.match(new RegExp(`\\.${selector}[^{}]*\\{[^}]*?color: (#[a-f0-9]+)`));
    const color = rule?.[1]; assert.ok(color, selector);
    assert.ok(ratio(color, background) >= minimum, `${selector} ${color} vs ${background}`);
  }
  assert.match(style, /:active[^}]*brightness/);
});

test("URL remains escaped, inactive, direction-isolated untrusted text even with markup and bidi input", () => {
  const url = 'https://example.com:9443/</bdi><script>alert("x")</script>?q="&x=\u202eevil';
  const html = externalLinkDocument(url);
  assert.ok(html.includes("&lt;/bdi&gt;&lt;script&gt;"));
  assert.ok(html.includes("&quot;x&quot;"));
  assert.ok(html.includes("&amp;x="));
  assert.doesNotMatch(html, /<script>|\u202e/);
  const longURL = `https://example.com/${"x".repeat(100_000)}`;
  assert.ok(externalLinkDocument(longURL).includes("x".repeat(100_000)));
});
