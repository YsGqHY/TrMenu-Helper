const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const TRMENU_MENUS_PATH = '/plugins/trmenu/menus';
const SNIPPETS_FILE = path.join(__dirname, 'snippets', 'TrMenu配置补全.code-snippets');
const VALID_RENDER_TYPES = new Set(['chest', 'window', 'dialog']);

const ROOT_KEYS = new Set([
  'title',
  'title-update',
  'layout',
  'playerinventory',
  'options',
  'bindings',
  'events',
  'icons',
  'tasks',
  'functions',
  'dialog',
  'render-type'
]);

const DISPLAY_KEYS = new Set([
  'material',
  'texture',
  'mat',
  'mats',
  'name',
  'display-name',
  'lore',
  'display-lore',
  'amount',
  'amt',
  'shiny',
  'glow',
  'flags',
  'enchant',
  'enchants',
  'enchantment',
  'enchantments',
  'nbt',
  'data',
  'slot',
  'slots',
  'page',
  'pages',
  'tooltip',
  'tooltip-style',
  'item-model',
  'model',
  'hide-tooltip',
  'unbreakable'
]);

const DISPLAY_CONTAINER_KEYS = new Set(['display', 'displayes', 'displays']);
// 仅匹配图标动作容器，故意不含 click，避免与 Events.Click 冲突
const ACTION_CONTAINER_KEYS = new Set(['actions', 'action']);
const ICON_ACTION_KEYS = new Set(['actions', 'action']);
const EVENT_KEYS = new Set(['open', 'close', 'click']);
const VALID_CLICK_TYPES = new Set([
  'all',
  'left',
  'right',
  'shift-left',
  'shift-right',
  'offhand',
  'number-key',
  'number-key-1',
  'number-key-2',
  'number-key-3',
  'number-key-4',
  'number-key-5',
  'number-key-6',
  'number-key-7',
  'number-key-8',
  'number-key-9',
  'middle',
  'drop',
  'control-drop',
  'abroad-left-empty',
  'abroad-right-empty',
  'abroad-left-item',
  'abroad-right-item',
  'left-mouse-drag-add',
  'right-mouse-drag-add',
  'middle-mouse-drag-add',
  'double-click'
]);

// Dialog 子树内才使用的细分子键，仅用于在 Dialog 路径中分类，不参与跨树命中
const DIALOG_SUB_KEYS = new Set([
  'pages',
  'body',
  'actions',
  'exit-action',
  'renderer',
  'widgets',
  'layout',
  'compiler',
  'execute',
  'deny',
  'type',
  'id',
  'label',
  'title',
  'next-page',
  'min-version',
  'fallback-menu',
  'allow-esc-close',
  'external-title'
]);

const SEMANTIC_TOKEN_TYPES = ['keyword', 'property', 'function', 'enumMember', 'type'];
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES);

// 简单的按 (uri@version) 缓存，避免按键时三次重复解析
const analysisCache = new Map();

function activate(context) {
  let snippets;
  try {
    snippets = loadSnippets();
  } catch (error) {
    snippets = [];
    vscode.window.showErrorMessage(
      `TrMenu Helper 加载 snippets 失败：${error && error.message ? error.message : error}`
    );
  }

  const diagnostics = vscode.languages.createDiagnosticCollection('trmenu-helper');
  const decorations = createDecorations();

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'yaml', scheme: 'file' },
    {
      provideCompletionItems(document) {
        if (!isTrMenuMenuFile(document)) {
          return [];
        }

        return snippets;
      }
    }
  );

  const semanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
    { language: 'yaml', scheme: 'file' },
    {
      provideDocumentSemanticTokens(document) {
        if (!isTrMenuMenuFile(document)) {
          return new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND).build();
        }

        return buildSemanticTokens(getAnalysis(document).entries);
      }
    },
    SEMANTIC_LEGEND
  );

  context.subscriptions.push(
    completionProvider,
    semanticProvider,
    diagnostics,
    decorations.root,
    decorations.display,
    decorations.action,
    decorations.dialog,
    vscode.workspace.onDidOpenTextDocument((document) => updateDiagnostics(document, diagnostics)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      invalidateCache(event.document);
      updateDiagnostics(event.document, diagnostics);
      updateVisibleDecorations(decorations);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      analysisCache.delete(document.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateVisibleDecorations(decorations)),
    vscode.window.onDidChangeVisibleTextEditors(() => updateVisibleDecorations(decorations))
  );

  vscode.workspace.textDocuments.forEach((document) => updateDiagnostics(document, diagnostics));
  updateVisibleDecorations(decorations);
}

function deactivate() {
  analysisCache.clear();
}

function isTrMenuMenuFile(document) {
  if (!document || document.uri.scheme !== 'file') {
    return false;
  }

  const normalizedPath = document.uri.fsPath.replace(/\\/g, '/').toLowerCase();
  return normalizedPath.includes(`${TRMENU_MENUS_PATH}/`) || normalizedPath.endsWith(TRMENU_MENUS_PATH);
}

function isYamlDocument(document) {
  return document && (document.languageId === 'yaml' || document.languageId === 'yml');
}

function updateDiagnostics(document, collection) {
  if (!isYamlDocument(document) || !isTrMenuMenuFile(document)) {
    collection.delete(document.uri);
    return;
  }

  collection.set(document.uri, getAnalysis(document).diagnostics);
}

function updateVisibleDecorations(decorations) {
  vscode.window.visibleTextEditors.forEach((editor) => updateDecorations(editor, decorations));
}

function updateDecorations(editor, decorations) {
  if (!editor || !isYamlDocument(editor.document) || !isTrMenuMenuFile(editor.document)) {
    clearDecorations(editor, decorations);
    return;
  }

  const analysis = getAnalysis(editor.document);
  editor.setDecorations(decorations.root, analysis.highlights.root);
  editor.setDecorations(decorations.display, analysis.highlights.display);
  editor.setDecorations(decorations.action, analysis.highlights.action);
  editor.setDecorations(decorations.dialog, analysis.highlights.dialog);
}

function clearDecorations(editor, decorations) {
  if (!editor) {
    return;
  }

  editor.setDecorations(decorations.root, []);
  editor.setDecorations(decorations.display, []);
  editor.setDecorations(decorations.action, []);
  editor.setDecorations(decorations.dialog, []);
}

function createDecorations() {
  return {
    root: vscode.window.createTextEditorDecorationType({ color: '#ffd166', fontWeight: '600' }),
    display: vscode.window.createTextEditorDecorationType({ color: '#4cc9f0', fontWeight: '600' }),
    action: vscode.window.createTextEditorDecorationType({ color: '#f4a261', fontWeight: '600' }),
    dialog: vscode.window.createTextEditorDecorationType({ color: '#c77dff', fontWeight: '600' })
  };
}

function getAnalysis(document) {
  const cacheKey = document.uri.toString();
  const cached = analysisCache.get(cacheKey);
  if (cached && cached.version === document.version) {
    return cached.analysis;
  }

  const analysis = analyzeDocument(document);
  analysisCache.set(cacheKey, { version: document.version, analysis });
  return analysis;
}

function invalidateCache(document) {
  if (document) {
    analysisCache.delete(document.uri.toString());
  }
}

function analyzeDocument(document) {
  const entries = parseYamlLikeEntries(document);
  const diagnostics = [];
  const highlights = {
    root: [],
    display: [],
    action: [],
    dialog: []
  };
  const rootKeys = new Set();
  let renderTypeDialog = false;
  let renderTypeEntry;
  let dialogEntry;
  let dialogPagesEntry;
  let firstMeaningfulRange;

  entries.forEach((entry) => {
    const key = entry.normalizedKey;
    const parentKey = entry.normalizedParentKey;
    const pathKeys = entry.normalizedPath;

    if (!firstMeaningfulRange) {
      firstMeaningfulRange = entry.range;
    }

    collectHighlight(entry, pathKeys, key, parentKey, highlights);

    if (entry.path.length === 1) {
      rootKeys.add(key);
      if (key === 'render-type') {
        const value = normalizeValue(entry.value);
        if (value === 'dialog') {
          renderTypeDialog = true;
          renderTypeEntry = entry;
        } else if (value && !VALID_RENDER_TYPES.has(value)) {
          diagnostics.push(createDiagnostic(
            entry,
            `未知的 Render-Type: ${entry.value}。常用值为 CHEST、WINDOW、DIALOG。`,
            vscode.DiagnosticSeverity.Warning
          ));
        }
      }
      if (key === 'dialog') {
        dialogEntry = entry;
      }
      if (key === 'buttons') {
        diagnostics.push(createDiagnostic(
          entry,
          'TrMenu 菜单图标根节点应使用 Icons，而不是旧的 Buttons。',
          vscode.DiagnosticSeverity.Warning
        ));
      }
    }

    if (pathKeys.length === 2 && pathKeys[0] === 'events' && !EVENT_KEYS.has(key)) {
      diagnostics.push(createDiagnostic(
        entry,
        `未知的 TrMenu 事件 ${entry.key}，常用事件为 Open、Close、Click。`,
        vscode.DiagnosticSeverity.Warning
      ));
    }

    if (pathKeys[0] === 'dialog' && pathKeys.length === 2 && key === 'pages') {
      dialogPagesEntry = entry;
    }

    if (isIconActionType(pathKeys, key, parentKey) && !VALID_CLICK_TYPES.has(key)) {
      diagnostics.push(createDiagnostic(
        entry,
        `未知的 TrMenu 图标点击类型 ${entry.key}。常用类型包括 all、left、right、shift_left、shift_right、offhand、number_key_1、double_click。`,
        vscode.DiagnosticSeverity.Error
      ));
    }

    if (isDisplayFieldOutsideDisplay(pathKeys, key)) {
      diagnostics.push(createDiagnostic(
        entry,
        `图标显示字段 ${entry.key} 应写在 display: 节点中。`,
        vscode.DiagnosticSeverity.Error
      ));
    }

    if (key === 'mats' && pathKeys[0] === 'icons' && isInsideIconDisplay(pathKeys)) {
      diagnostics.push(createDiagnostic(
        entry,
        'mats 虽可被 TrMenu 兼容，但推荐使用最新版字段 material。',
        vscode.DiagnosticSeverity.Information
      ));
    }
  });

  // 图标 actions: 直接接列表项（未指定 all/left 等点击类型）属于不规范写法，需要标红
  entries.forEach((entry) => {
    if (entry.normalizedPath[0] !== 'icons') {
      return;
    }
    if (!ICON_ACTION_KEYS.has(entry.normalizedKey)) {
      return;
    }
    if (ICON_ACTION_KEYS.has(entry.normalizedParentKey)) {
      return;
    }

    const next = findNextContentLine(document, entry.line + 1);
    if (!next || next.indent <= entry.indent) {
      return;
    }

    if (/^\s*-\s/.test(next.text)) {
      diagnostics.push(createDiagnostic(
        entry,
        'actions 下需要先指定点击类型 (例如 all、left、right)，再在下层写动作列表。',
        vscode.DiagnosticSeverity.Error
      ));
    }
  });

  const isDraftDocument = entries.length < 3;
  if (entries.length > 0 && !renderTypeDialog && !isDraftDocument) {
    if (!rootKeys.has('layout')) {
      diagnostics.push(createDocumentDiagnostic(
        document,
        firstMeaningfulRange,
        '传统 TrMenu 菜单通常需要 Layout 节点。',
        vscode.DiagnosticSeverity.Hint
      ));
    }
    if (!rootKeys.has('icons')) {
      diagnostics.push(createDocumentDiagnostic(
        document,
        firstMeaningfulRange,
        '传统 TrMenu 菜单通常需要 Icons 节点。',
        vscode.DiagnosticSeverity.Hint
      ));
    }
  }

  if (renderTypeDialog) {
    if (!rootKeys.has('dialog')) {
      diagnostics.push(createDiagnostic(
        renderTypeEntry,
        'Render-Type: DIALOG 需要配置 Dialog 节点。',
        vscode.DiagnosticSeverity.Error
      ));
    } else if (!dialogPagesEntry) {
      diagnostics.push(createDiagnostic(
        dialogEntry,
        'Dialog 菜单需要配置 Dialog.Pages 页面列表。',
        vscode.DiagnosticSeverity.Error
      ));
    }

    if (rootKeys.has('icons')) {
      const iconsEntry = entries.find((entry) => entry.normalizedKey === 'icons' && entry.path.length === 1);
      diagnostics.push(createDiagnostic(
        iconsEntry || renderTypeEntry,
        'Dialog 渲染模式不会使用传统 Icons 配置，请将内容写入 Dialog.Pages。',
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }

  return { entries, diagnostics, highlights };
}

function parseYamlLikeEntries(document) {
  const stack = [];
  const entries = [];
  // 块式标量状态：当处于 |/> 标量内部时跳过其下行
  let blockScalar = null;

  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;

    if (blockScalar) {
      const indent = leadingSpaces(text);
      if (text.trim() === '' || indent > blockScalar.indent) {
        continue;
      }
      blockScalar = null;
    }

    const parsed = parseKeyLine(text, line);
    if (!parsed) {
      continue;
    }

    while (stack.length > 0 && parsed.indent < stack[stack.length - 1].childIndent) {
      stack.pop();
    }
    if (stack.length > 0 && parsed.indent === stack[stack.length - 1].indent && !stack[stack.length - 1].syntheticListAnchor) {
      stack.pop();
    }

    // 列表项 `- key: value` 注入一个合成锚点节点，让同一列表内的兄弟字段保持平级
    if (parsed.isListItem) {
      while (stack.length > 0 && stack[stack.length - 1].syntheticListAnchor && stack[stack.length - 1].indent === parsed.indent) {
        stack.pop();
      }
      stack.push({
        key: '',
        normalizedKey: '',
        indent: parsed.indent,
        childIndent: parsed.indent + 2,
        syntheticListAnchor: true
      });
    }

    const rawPathKeys = stack.map((entry) => entry.key).concat(parsed.key);
    const pathKeys = rawPathKeys.filter((segment) => segment !== '');
    const normalizedPath = pathKeys.map(normalizeKey);
    const visibleParent = findVisibleParent(stack);
    const parentKey = visibleParent ? visibleParent.key : undefined;
    const entry = {
      ...parsed,
      path: pathKeys,
      normalizedPath,
      normalizedKey: normalizeKey(parsed.key),
      parentKey,
      normalizedParentKey: normalizeKey(parentKey),
      range: new vscode.Range(line, parsed.keyStart, line, parsed.keyEnd)
    };

    entries.push(entry);
    stack.push(entry);

    // 进入块式标量后，跳过整个标量体，边界使用父 key 的 leading 缩进
    if (isBlockScalarValue(parsed.value)) {
      blockScalar = { indent: parsed.indent };
    }
  }

  return entries;
}

function findVisibleParent(stack) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (!entry.syntheticListAnchor) {
      return entry;
    }
  }
  return undefined;
}

function parseKeyLine(text, line) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }

  // 限定 key 起始字符，避免 JS 代码、URL、含括号等内容被识别为 key
  const match = text.match(/^(\s*)(-\s+)?(?:(["'])(.*?)\3|([A-Za-z_][\w.\-]*))\s*:(\s.*|$)/);
  if (!match) {
    return undefined;
  }

  const leading = match[1] || '';
  const listMarker = match[2] || '';
  const key = (match[4] || match[5] || '').trim();
  if (!key) {
    return undefined;
  }

  const keyOffset = leading.length + listMarker.length;
  const keyStart = text.indexOf(key, keyOffset);
  const keyEnd = keyStart + key.length;
  return {
    line,
    indent: leading.length,
    childIndent: keyOffset + 2,
    isListItem: listMarker.length > 0,
    key,
    keyStart,
    keyEnd,
    value: (match[6] || '').trim()
  };
}

function leadingSpaces(text) {
  const match = text.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findNextContentLine(document, fromLine) {
  for (let line = fromLine; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    return { line, text, indent: leadingSpaces(text) };
  }
  return undefined;
}

function isBlockScalarValue(value) {
  // 仅识别 |, >, |-, >+, |2 这类 YAML 块式标量指示符
  return /^[|>][+-]?\d*$/.test((value || '').trim());
}

function collectHighlight(entry, pathKeys, key, parentKey, highlights) {
  // Dialog 子树独占一个高亮通道，避免与传统菜单同名键串色
  if (pathKeys[0] === 'dialog') {
    highlights.dialog.push(entry.range);
    return;
  }

  if (entry.path.length === 1 && ROOT_KEYS.has(key)) {
    highlights.root.push(entry.range);
  }

  if (pathKeys[0] === 'icons' && !isInsideCatcherActionConfig(pathKeys) && (isInsideIconDisplay(pathKeys) || DISPLAY_CONTAINER_KEYS.has(key) || DISPLAY_KEYS.has(key))) {
    highlights.display.push(entry.range);
  }

  // 仅在图标 actions 子树下高亮点击类型，避免误染 Events.Click
  if (pathKeys[0] === 'icons' && (ACTION_CONTAINER_KEYS.has(key) || (ICON_ACTION_KEYS.has(parentKey) && VALID_CLICK_TYPES.has(key)))) {
    highlights.action.push(entry.range);
  }
}

function buildSemanticTokens(entries) {
  const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);

  entries.forEach((entry) => {
    const key = entry.normalizedKey;
    const parentKey = entry.normalizedParentKey;
    const pathKeys = entry.normalizedPath;
    const range = entry.range;
    let tokenType;

    if (entry.path.length === 1 && ROOT_KEYS.has(key)) {
      tokenType = 'keyword';
    } else if (pathKeys[0] === 'dialog') {
      tokenType = DIALOG_SUB_KEYS.has(key) ? 'type' : 'property';
    } else if (pathKeys[0] === 'icons' && ICON_ACTION_KEYS.has(parentKey) && VALID_CLICK_TYPES.has(key)) {
      tokenType = 'enumMember';
    } else if (pathKeys[0] === 'icons' && ACTION_CONTAINER_KEYS.has(key)) {
      tokenType = 'function';
    } else if (pathKeys[0] === 'icons' && !isInsideCatcherActionConfig(pathKeys) && (isInsideIconDisplay(pathKeys) || DISPLAY_KEYS.has(key))) {
      tokenType = 'property';
    }

    if (tokenType) {
      builder.push(range, tokenType, []);
    }
  });

  return builder.build();
}

function isIconActionType(pathKeys, key, parentKey) {
  if (pathKeys[0] !== 'icons' || !ICON_ACTION_KEYS.has(parentKey)) {
    return false;
  }

  return !ICON_ACTION_KEYS.has(key);
}

function isDisplayFieldOutsideDisplay(pathKeys, key) {
  if (pathKeys[0] !== 'icons' || !DISPLAY_KEYS.has(key) || key === 'mats') {
    return false;
  }

  if (isInsideCatcherActionConfig(pathKeys)) {
    return false;
  }

  return !isInsideIconDisplay(pathKeys) && isInsideIconBody(pathKeys);
}

function isInsideIconDisplay(pathKeys) {
  if (pathKeys[0] !== 'icons') {
    return false;
  }

  return pathKeys.some((key) => DISPLAY_CONTAINER_KEYS.has(key)) && !isInsideCatcherActionConfig(pathKeys);
}

function isInsideCatcherActionConfig(pathKeys) {
  if (pathKeys[0] !== 'icons') {
    return false;
  }

  const catcherIndex = pathKeys.lastIndexOf('catcher');
  if (catcherIndex < 3 || catcherIndex === pathKeys.length - 1) {
    return false;
  }

  return ACTION_CONTAINER_KEYS.has(pathKeys[catcherIndex - 2]) && VALID_CLICK_TYPES.has(pathKeys[catcherIndex - 1]);
}

function isInsideIconBody(pathKeys) {
  if (pathKeys.length < 3 || pathKeys[0] !== 'icons') {
    return false;
  }

  const parentKey = pathKeys[pathKeys.length - 2];
  return !ACTION_CONTAINER_KEYS.has(parentKey) && parentKey !== 'nbt' && parentKey !== 'enchant';
}

function createDiagnostic(entry, message, severity) {
  return new vscode.Diagnostic(entry.range, message, severity);
}

function createDocumentDiagnostic(document, range, message, severity) {
  const safeRange = range || new vscode.Range(0, 0, 0, Math.max(document.lineAt(0).text.length, 1));
  return new vscode.Diagnostic(safeRange, message, severity);
}

function normalizeKey(key) {
  return String(key || '').trim().replace(/_/g, '-').toLowerCase();
}

function normalizeValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function loadSnippets() {
  const raw = fs.readFileSync(SNIPPETS_FILE, 'utf8');
  const snippets = JSON.parse(raw);
  const items = [];

  Object.entries(snippets).forEach(([name, snippet]) => {
    const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
    const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : String(snippet.body || '');

    prefixes.filter(Boolean).forEach((prefix) => {
      const item = new vscode.CompletionItem(prefix, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(body);
      item.detail = name;
      item.documentation = snippet.description ? new vscode.MarkdownString(snippet.description) : undefined;
      item.filterText = prefix;
      item.sortText = `0_${prefix}`;
      items.push(item);
    });
  });

  return items;
}

module.exports = {
  activate,
  deactivate,
  isTrMenuMenuFile,
  parseKeyLine,
  parseYamlLikeEntries,
  analyzeDocument,
  normalizeKey
};
