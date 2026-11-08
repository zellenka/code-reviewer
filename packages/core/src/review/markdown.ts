/**
 * Makes model-written markdown safe to show: images become plain links, so nothing
 * is fetched just by rendering the text (a prompt injection could otherwise put
 * code from the diff into an image URL), and HTML tags are shown as text.
 * Code blocks and inline code are left as they are.
 */
export function neutralizeMarkdown(text: string): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (fence) return line;
      return line.replace(/(`+)[^`]*?\1|!\[|<(?=[A-Za-z/!?])/g, (match, code?: string) => {
        if (code) return match;
        return match === '![' ? '\\![' : '&lt;';
      });
    })
    .join('\n');
}
