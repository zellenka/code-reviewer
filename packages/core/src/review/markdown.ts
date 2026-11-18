/**
 * Makes model-written markdown safe to show: images become plain links, so nothing
 * is fetched just by rendering the text (a prompt injection could otherwise put
 * code from the diff into an image URL), and HTML tags are shown as text.
 * Code blocks and inline code are left as they are. The text is taken to start a
 * new block, so callers put it after a blank line.
 */
export function neutralizeMarkdown(text: string): string {
  let fence: string | undefined;
  // An indented code block starts after a blank line (it can't interrupt a paragraph)
  // and runs on over blank lines. Inside a list indented lines are the item's text,
  // so they are treated as text until a line at the left margin ends the list.
  let blank = true;
  let indentedCode = false;
  let list = false;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        blank = indentedCode = false;
        return line;
      }
      if (fence) return line;
      if (/^[ \t]*$/.test(line)) {
        blank = true;
        return line;
      }
      if (/^(?: {4}| {0,3}\t)/.test(line) && (blank || indentedCode) && !list) {
        blank = false;
        indentedCode = true;
        return line;
      }
      if (blank && /^\S/.test(line)) list = false;
      if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) list = true;
      blank = indentedCode = false;
      return line.replace(/(`+)[^`]*?\1|!\[|<(?=[A-Za-z/!?])/g, (match, code?: string) => {
        if (code) return match;
        return match === '![' ? '\\![' : '&lt;';
      });
    })
    .join('\n');
}
