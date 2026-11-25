/** Pull http(s) links out of pasted text, dropping quotes/brackets/punctuation stuck to them. */
export function parseUrls(value: unknown): string[] {
  const text = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  const urls = text
    .split(/[\s,]+/)
    .map((s) =>
      s
        .trim()
        .replace(/^["'“”‘’(<[]+/, "")
        .replace(/(?:["'“”‘’)>\].;!]|%22|%27)+$/i, ""),
    )
    .filter((s) => /^https?:\/\/\S+\.\S+/i.test(s));
  return [...new Set(urls)];
}
