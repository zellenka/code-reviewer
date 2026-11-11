/**
 * HTML for the "Review" sidebar view. Static markup; the script fills it from
 * `state` messages using textContent only (names come from git and the workspace).
 */
export function panelHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Review</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    padding: 4px 12px 16px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  h3 {
    margin: 14px 0 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  fieldset { border: 0; margin: 0; padding: 0; }
  .scope {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 6px;
    align-items: start;
    padding: 4px 6px;
    border-radius: 3px;
    cursor: pointer;
  }
  .scope:hover { background: var(--vscode-list-hoverBackground); }
  .scope input { margin: 2px 0 0; }
  .scope.disabled { opacity: 0.55; cursor: default; }
  .scope .hint {
    grid-column: 2;
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
    overflow-wrap: anywhere;
  }
  .base { grid-column: 2; margin-top: 4px; }
  .base[hidden] { display: none; }
  input[type=text], select {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border, transparent));
    border-radius: 2px;
    font: inherit;
  }
  select {
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border-color: var(--vscode-dropdown-border, transparent);
  }
  input[type=text]:focus, select:focus, button:focus-visible, input:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .row { display: flex; gap: 6px; align-items: center; }
  .row .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .check { display: flex; gap: 6px; align-items: center; margin-top: 8px; cursor: pointer; }
  button {
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    font: inherit;
    cursor: pointer;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary {
    width: 100%;
    margin-top: 16px;
    padding: 6px 10px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--vscode-textLink-foreground);
  }
  button.link:hover { text-decoration: underline; background: none; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .muted { color: var(--vscode-descriptionForeground); }
  .result {
    margin-top: 14px;
    padding: 8px;
    border-left: 2px solid var(--vscode-textLink-foreground);
    background: var(--vscode-textBlockQuote-background);
    overflow-wrap: anywhere;
  }
  .result.warn, .result.error { border-left-color: var(--vscode-editorWarning-foreground); }
  .result .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 6px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: -1px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h3 id="scope-title">What to review</h3>
  <fieldset aria-labelledby="scope-title">
    <label class="scope" data-scope="unstaged">
      <input type="radio" name="scope" value="unstaged"><span>Unstaged changes</span>
      <span class="hint">Working tree, including new files</span>
    </label>
    <label class="scope" data-scope="staged">
      <input type="radio" name="scope" value="staged"><span>Staged changes</span>
      <span class="hint">What the next commit contains</span>
    </label>
    <label class="scope" data-scope="branch">
      <input type="radio" name="scope" value="branch"><span>Branch changes</span>
      <span class="hint">Everything since the branch left its base</span>
      <span class="base" id="base-row">
        <input type="text" id="base" list="branches" aria-label="Base branch" spellcheck="false">
        <datalist id="branches"></datalist>
      </span>
    </label>
    <label class="scope" data-scope="file">
      <input type="radio" name="scope" value="file"><span>Current file</span>
      <span class="hint" id="file-hint"></span>
    </label>
    <label class="scope" data-scope="selection">
      <input type="radio" name="scope" value="selection"><span>Selection</span>
      <span class="hint" id="selection-hint"></span>
    </label>
  </fieldset>

  <div id="repo-section" hidden>
    <h3><label for="repo">Repository</label></h3>
    <select id="repo"></select>
  </div>

  <h3>Model</h3>
  <div class="row">
    <span class="grow" id="model"></span>
    <button id="model-change" title="Choose the model used for reviews">Change</button>
  </div>
  <div id="model-problem" class="warn" hidden></div>

  <h3><label for="mode">Review mode</label></h3>
  <select id="mode">
    <option value="auto">Auto (repository setting)</option>
    <option value="single-pass">Single pass: the diff and nearby code</option>
    <option value="agentic">Agentic: may read related files (slower)</option>
  </select>
  <label class="check"><input type="checkbox" id="context"><span>Include surrounding code</span></label>
  <label class="check" title="One extra request per file with findings; drops findings the model rejects on a second look."><input type="checkbox" id="verify"><span>Double-check findings</span></label>

  <button class="primary" id="run">Run Review</button>
  <button class="primary" id="cancel" hidden><span class="spinner" aria-hidden="true"></span>Cancel Review</button>

  <div id="result" class="result" role="status" hidden>
    <div id="result-text"></div>
    <div class="actions">
      <button class="link" id="show-findings" hidden>Show findings</button>
      <button class="link" id="show-summary" hidden>Show summary</button>
      <button class="link" id="show-log" hidden>Show log</button>
      <button class="link" id="clear" hidden>Clear</button>
    </div>
  </div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (type, value) => vscode.postMessage({ type, value });
  let state;

  document.querySelectorAll('input[name=scope]').forEach((radio) =>
    radio.addEventListener('change', () => send('scope', radio.value)));
  $('base').addEventListener('change', () => send('base', $('base').value));
  $('base').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('base').blur(); });
  $('repo').addEventListener('change', () => send('root', $('repo').value));
  $('mode').addEventListener('change', () => send('reviewMode', $('mode').value));
  $('context').addEventListener('change', () => send('includeContext', $('context').checked));
  $('verify').addEventListener('change', () => send('verifyFindings', $('verify').checked));
  $('run').addEventListener('click', () => {
    if (document.activeElement === $('base')) send('base', $('base').value);
    send('run');
  });
  $('cancel').addEventListener('click', () => send('cancel'));
  $('model-change').addEventListener('click', () =>
    send('command', state && state.model.needsKey ? 'aiReview.setAnthropicApiKey' : 'aiReview.selectModel'));
  $('show-findings').addEventListener('click', () => send('command', 'aiReview.findings.focus'));
  $('show-summary').addEventListener('click', () => send('command', 'aiReview.showSummary'));
  $('show-log').addEventListener('click', () => send('command', 'aiReview.showLog'));
  $('clear').addEventListener('click', () => send('command', 'aiReview.clearFindings'));

  function render(s) {
    state = s;
    const targets = {
      file: s.file,
      selection: s.selection,
    };
    document.querySelectorAll('.scope').forEach((row) => {
      const scope = row.dataset.scope;
      const radio = row.querySelector('input[type=radio]');
      radio.checked = scope === s.scope;
      radio.disabled = s.running;
      row.classList.toggle('disabled', (scope in targets && !targets[scope]) || s.running);
    });
    $('file-hint').textContent = s.file || 'Open a file in the editor';
    $('selection-hint').textContent = s.selection || 'Select code in the editor';

    $('base-row').hidden = s.scope !== 'branch';
    if (document.activeElement !== $('base')) $('base').value = s.base;
    $('base').placeholder = 'Base: ' + s.basePlaceholder;
    $('base').disabled = s.running;
    const list = $('branches');
    list.replaceChildren(...s.branches.map((b) => Object.assign(document.createElement('option'), { value: b })));

    const showRepo = s.roots.length > 1 && s.scope !== 'file' && s.scope !== 'selection';
    $('repo-section').hidden = !showRepo;
    const repo = $('repo');
    repo.replaceChildren(
      Object.assign(document.createElement('option'), { value: '', textContent: 'Active editor\\'s repository' }),
      ...s.roots.map((r) => Object.assign(document.createElement('option'), { value: r.root, textContent: r.label, title: r.root })),
    );
    repo.value = s.root;
    repo.disabled = s.running;

    $('model').textContent = s.model.label;
    $('model').title = s.model.label;
    $('model-change').textContent = s.model.needsKey ? 'Set API Key' : 'Change';
    $('model-problem').hidden = s.model.ok;
    $('model-problem').textContent = s.model.detail || '';

    $('mode').value = s.reviewMode;
    $('mode').disabled = s.running;
    $('context').checked = s.includeContext;
    $('context').disabled = s.running;
    $('verify').checked = s.verifyFindings;
    $('verify').disabled = s.running;

    const missingTarget = s.scope in targets && !targets[s.scope];
    $('run').hidden = s.running;
    $('run').disabled = missingTarget || !s.model.ok;
    $('run').title = missingTarget
      ? (s.scope === 'file' ? 'Open a file first' : 'Select some code first')
      : !s.model.ok ? 'Set up a model first' : '';
    $('cancel').hidden = !s.running;

    const last = s.last;
    $('result').hidden = !last;
    if (last) {
      $('result').className = 'result ' + last.level;
      $('result-text').textContent = last.text;
      $('show-findings').hidden = !last.open;
      $('show-findings').textContent = 'Show ' + last.open + ' open finding' + (last.open === 1 ? '' : 's');
      $('show-summary').hidden = !last.hasSummary;
      $('show-log').hidden = last.level === 'info';
      $('clear').hidden = last.level !== 'info';
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data.state);
  });
  send('ready');
})();
</script>
</body>
</html>`;
}
