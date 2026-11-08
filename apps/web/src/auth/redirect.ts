/** 仅接受站内单斜杠路径，拒绝 URL 规范化可能解释为域名的写法。 */
export function sanitizeRedirect(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//"))
    return "/apps";
  if (
    Array.from(value).some(
      (character) =>
        character === "\\" ||
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127,
    ) ||
    /%2f|%5c|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(value.split(/[?#]/, 1)[0] ?? "")
  )
    return "/apps";
  return value;
}
