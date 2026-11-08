/** 可变内容既可能位于文本也可能位于属性；统一转义，避免邮箱或链接注入 HTML。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** AIFlow 验证信只接收已构造的链接，不读取配置或持久化令牌。 */
export function verificationEmailHtml(input: {
  to: string;
  url: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><title>验证你的 AIFlow 邮箱</title></head>
  <body>
    <h1>欢迎使用 AIFlow</h1>
    <p>请确认 ${escapeHtml(input.to)} 是你的邮箱。</p>
    <p><a href="${escapeHtml(input.url)}">验证邮箱</a></p>
    <p>链接在 24 小时后失效。如果你没有注册 AIFlow，请忽略此邮件。</p>
  </body>
</html>`;
}
