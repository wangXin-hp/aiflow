/** 分块偏移使用 JavaScript 字符串的 UTF-16 位置，可直接通过 slice 还原。 */
export interface TextChunk {
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  headings?: string[];
}
export interface ChunkingOptions {
  chunkSize: number;
  chunkOverlap: number;
}
function validate(options: ChunkingOptions): void {
  if (
    !Number.isInteger(options.chunkSize) ||
    options.chunkSize < 1 ||
    options.chunkSize > 100_000 ||
    !Number.isInteger(options.chunkOverlap) ||
    options.chunkOverlap < 0 ||
    options.chunkOverlap >= options.chunkSize
  )
    throw new RangeError("Invalid chunk size or overlap");
}
/** 按 Unicode 码点计数，避免将代理对切开；重叠尺寸小于分块尺寸。 */
export function splitText(text: string, options: ChunkingOptions): TextChunk[] {
  validate(options);
  if (text.length > 2_000_000)
    throw new RangeError("Document exceeds size limit");
  const chars = Array.from(text);
  const offsets = [0];
  for (const char of chars)
    offsets.push(offsets[offsets.length - 1]! + char.length);
  const chunks: TextChunk[] = [];
  for (let start = 0; start < chars.length;) {
    const end = Math.min(start + options.chunkSize, chars.length);
    const startOffset = offsets[start]!,
      endOffset = offsets[end]!;
    if (chunks.length >= 1000)
      throw new RangeError("Document has too many chunks");
    chunks.push({
      content: text.slice(startOffset, endOffset),
      index: chunks.length,
      startOffset,
      endOffset,
    });
    if (end === chars.length) break;
    start = end - options.chunkOverlap;
  }
  return chunks;
}
/** 按标题分节并携带标题路径；围栏代码块中的井号不是标题。 */
export function splitMarkdown(
  text: string,
  options: ChunkingOptions,
): TextChunk[] {
  validate(options);
  if (text.length > 2_000_000)
    throw new RangeError("Document exceeds size limit");
  if (!text) return [];
  const sections: Array<{ start: number; end: number; headings: string[] }> =
    [];
  const headings: Array<{ level: number; title: string }> = [];
  let sectionStart = 0,
    currentHeadings: string[] = [],
    offset = 0,
    fence: { char: string; length: number } | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const content = line.replace(/\r?\n$/, "");
    const marker = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1]!;
      if (!fence) fence = { char: token[0]!, length: token.length };
      else if (
        token[0] === fence.char &&
        token.length >= fence.length &&
        content.slice(marker[0].length).trim() === ""
      )
        fence = undefined;
    } else if (!fence) {
      const header = content.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
      if (header) {
        if (offset > sectionStart)
          sections.push({
            start: sectionStart,
            end: offset,
            headings: currentHeadings,
          });
        const level = header[1]!.length;
        while (headings.length && headings[headings.length - 1]!.level >= level)
          headings.pop();
        headings.push({ level, title: header[2]!.trim() });
        sectionStart = offset;
        currentHeadings = headings.map((entry) => entry.title);
      }
    }
    if (sections.length >= 1000)
      throw new RangeError("Document has too many sections");
    offset += line.length;
  }
  if (sectionStart < text.length)
    sections.push({
      start: sectionStart,
      end: text.length,
      headings: currentHeadings,
    });
  const chunks: TextChunk[] = [];
  for (const section of sections) {
    for (const chunk of splitText(
      text.slice(section.start, section.end),
      options,
    )) {
      if (chunks.length >= 1000)
        throw new RangeError("Document has too many chunks");
      chunks.push({
        ...chunk,
        index: chunks.length,
        startOffset: chunk.startOffset + section.start,
        endOffset: chunk.endOffset + section.start,
        headings: [...section.headings],
      });
    }
  }
  return chunks;
}
