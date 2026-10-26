import './monacoEnvironment';
import * as monaco from 'monaco-editor';
import { pineReference, type PineReferenceEntry } from './pineReference';
import { validatePineStaticSource } from './pineStaticValidator';

export type PineModel = monaco.editor.ITextModel;
export type PineEditor = monaco.editor.IStandaloneCodeEditor;

declare global {
  interface Window {
	addConsoleOutput?: (message: string, level?: string, diagnosticKey?: string) => void;
	clearConsoleDiagnostics?: (diagnosticKey: string) => void;
  }
}

const pineLanguageId = 'pine';
const syntaxOwner = 'pine-v6-validator';
const runtimeOwner = 'pine-runtime';
const editorFontSizeStorageKey = 'omega.pine-editor.font-size';
const defaultEditorFontSize = 15;

function savedEditorFontSize(): number {
  const value = Number(localStorage.getItem(editorFontSizeStorageKey));
  return Number.isFinite(value) ? Math.max(10, Math.min(30, Math.round(value))) : defaultEditorFontSize;
}

const pineKeywords = [
  'if', 'else', 'for', 'while', 'switch', 'break', 'continue', 'return',
  'var', 'varip', 'import', 'export', 'type', 'method', 'true', 'false', 'na',
];

const pineBuiltins = [
  'open', 'high', 'low', 'close', 'volume', 'time', 'bar_index', 'syminfo',
  'color', 'math', 'str', 'array', 'matrix', 'map', 'request', 'input',
  'plot', 'plotshape', 'plotchar', 'hline', 'fill', 'line', 'label', 'box',
  'shape', 'location', 'size', 'display',
];

let languageConfigured = false;

function configurePineLanguage(): void {
  if (languageConfigured) return;

  if (!monaco.languages.getLanguages().some(language => language.id === pineLanguageId)) {
	monaco.languages.register({ id: pineLanguageId, extensions: ['.pine'] });
  }
  monaco.languages.setLanguageConfiguration(pineLanguageId, {
	comments: { lineComment: '//' },
	brackets: [['{', '}'], ['[', ']'], ['(', ')']],
	autoClosingPairs: [
	  { open: '{', close: '}' },
	  { open: '[', close: ']' },
	  { open: '(', close: ')' },
	  { open: '"', close: '"' },
	  { open: "'", close: "'" },
	],
	surroundingPairs: [
	  { open: '{', close: '}' },
	  { open: '[', close: ']' },
	  { open: '(', close: ')' },
	  { open: '"', close: '"' },
	  { open: "'", close: "'" },
	],
	wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  });

  try {
  monaco.languages.setMonarchTokensProvider(pineLanguageId, {
	defaultToken: '',
	tokenPostfix: '.pine',
	keywords: pineKeywords,
	tokenizer: {
	  root: [
		[/\/\/.*$/, 'comment'],
		[/"([^"\\]|\\.)*$/, 'string.invalid'],
		[/'([^'\\]|\\.)*$/, 'string.invalid'],
		[/"/, 'string', '@string_double'],
		[/'/, 'string', '@string_single'],
		[/[a-zA-Z_]\w*(?=\s*\()/, 'function'],
		[/[a-zA-Z_]\w*(?=\.)/, 'namespace'],
		[/[a-zA-Z_]\w*/, {
		  cases: {
			'@keywords': 'keyword',
			'@default': 'identifier',
		  },
		}],
		[/(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/, 'number'],
		[/[{}()[\]]/, '@brackets'],
		[/[=+\-*\/%!<>:&|?]+/, 'operator'],
		[/[;,.]/, 'delimiter'],
		[/\s+/, 'white'],
	  ],
	  string_double: [
		[/[^\\"]+/, 'string'],
		[/\\./, 'string.escape'],
		[/"/, 'string', '@pop'],
	  ],
	  string_single: [
		[/[^\\']+/, 'string'],
		[/\\./, 'string.escape'],
		[/'/, 'string', '@pop'],
	  ],
	},
  });
  } catch (error) {
	throw new Error(`Pine language highlighting failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  monaco.editor.defineTheme('pine-dark', {
	base: 'vs-dark',
	inherit: true,
	rules: [
	  { token: 'metatag', foreground: 'C586C0' },
	  { token: 'namespace', foreground: '4FC1FF' },
	  { token: 'function', foreground: 'DCDCAA' },
	  { token: 'keyword', foreground: 'C586C0' },
	  { token: 'number', foreground: 'B5CEA8' },
	  { token: 'string', foreground: 'CE9178' },
	],
	colors: {
	  'editor.background': '#101d30',
	  'editorGutter.background': '#101d30',
	  'editorLineNumber.foreground': '#7892b1',
	  'editorLineNumber.activeForeground': '#f1f6ff',
	  'editorCursor.foreground': '#4D9CFF',
	  'editor.selectionBackground': '#284f7a',
	},
  });
  monaco.editor.defineTheme('pine-light', {
	base: 'vs',
	inherit: true,
	rules: [
	  { token: 'metatag', foreground: '800080' },
	  { token: 'namespace', foreground: '005A9E' },
	  { token: 'function', foreground: '795E26' },
	  { token: 'keyword', foreground: '7A1FA2' },
	  { token: 'number', foreground: '176B35' },
	  { token: 'string', foreground: 'A31515' },
	],
	colors: {
	  'editor.background': '#ffffff',
	  'editorGutter.background': '#f1f5f9',
	  'editorLineNumber.foreground': '#64748b',
	  'editorLineNumber.activeForeground': '#111827',
	  'editorCursor.foreground': '#1d4ed8',
	  'editor.selectionBackground': '#bfdbfe',
	},
  });

  monaco.languages.registerCompletionItemProvider(pineLanguageId, {
	triggerCharacters: ['.', '('],
	provideCompletionItems(model, position) {
	  const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
	  const prefixMatch = linePrefix.match(/[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*\.?$/);
	  const typedPrefix = prefixMatch?.[0] ?? '';
	  const startColumn = position.column - typedPrefix.length;
	  const range = new monaco.Range(position.lineNumber, startColumn, position.lineNumber, position.column);
	  const entries = pineReference.filter(entry => !typedPrefix || entry.name.toLowerCase().startsWith(typedPrefix.toLowerCase()) || entry.name.toLowerCase().includes(typedPrefix.toLowerCase()));
	  const items: monaco.languages.CompletionItem[] = entries.map(entry => ({
		label: entry.name,
		kind: entry.signature.includes('(') ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Value,
		detail: entry.signature,
		documentation: entry.description,
		insertText: entry.signature.includes('(') ? `${entry.name}($0)` : entry.name,
		insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
		range,
	  }));

	  const keywordItems = [...pineKeywords, ...pineBuiltins]
		.filter(keyword => !typedPrefix || keyword.toLowerCase().includes(typedPrefix.toLowerCase()))
		.map(keyword => ({
		  label: keyword,
		  kind: monaco.languages.CompletionItemKind.Keyword,
		  insertText: keyword,
		  range,
		}));
		const localNames = [...model.getValue().matchAll(/^\s*([a-zA-Z_]\w*)\s*=/gm)].map(match => match[1]);
	  const localItems = [...new Set(localNames)]
		.filter(name => !typedPrefix || name.toLowerCase().includes(typedPrefix.toLowerCase()))
		.map(name => ({
		  label: name,
		  kind: monaco.languages.CompletionItemKind.Variable,
		  insertText: name,
		  range,
		}));
	  return { suggestions: [...items, ...keywordItems, ...localItems] };
	},
  });

  monaco.languages.registerHoverProvider(pineLanguageId, {
	provideHover(model, position) {
	  const match = findReferenceAtPosition(model, position);
	  if (match) {
	    const entry = match.entry;
		const markdown = {
		value: `**${entry.name}**\n\n\`\`\`pine\n${entry.signature}\n\`\`\`\n\n${entry.description}${entry.manual ? '\n\n_Double-click the reference panel item for full documentation._' : ''}`,
	    };
	    return { range: match.range, contents: [markdown] };
	  }
	  return variableHover(model, position);
	},
  });

  monaco.languages.registerSignatureHelpProvider(pineLanguageId, {
	signatureHelpTriggerCharacters: ['(', ','],
	provideSignatureHelp(model, position): monaco.languages.ProviderResult<monaco.languages.SignatureHelpResult> {
	  const line = model.getLineContent(position.lineNumber);
	  const beforeCursor = line.slice(0, position.column - 1);
	  const callMatch = beforeCursor.match(/([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\([^()]*$/);
	  if (!callMatch) return undefined;
	  const entry = pineReference.find(item => item.name === callMatch[1]);
	  if (!entry) return undefined;
	  const openingColumn = beforeCursor.lastIndexOf('(');
	  const activeParameter = beforeCursor.slice(openingColumn + 1).split(',').length - 1;
	  const params = parseSignatureParameters(entry.signature);
	  return {
		value: {
		  signatures: [{
			label: entry.signature,
			documentation: entry.description,
			parameters: params.map(parameter => ({ label: parameter })),
		  }],
		  activeSignature: 0,
		  activeParameter: Math.min(activeParameter, Math.max(params.length - 1, 0)),
		},
		dispose: () => undefined,
	  };
	},
  });

  languageConfigured = true;
}

function parseSignatureParameters(signature: string): string[] {
  const start = signature.indexOf('(');
  const end = signature.lastIndexOf(')');
  if (start < 0 || end <= start) return [];
  return signature.slice(start + 1, end).split(',').map(parameter => parameter.trim()).filter(Boolean);
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function diagnosticRange(source: string, line: number, column = 1): { startColumn: number; endColumn: number } {
  const lines = source.split(/\r?\n/);
  const lineNumber = Math.max(1, Math.min(lines.length, line));
  const lineText = lines[lineNumber - 1] ?? '';
  const maxColumn = lineText.length + 1;
  if (!Number.isFinite(column) || column < 1 || column >= maxColumn) {
    return { startColumn: 1, endColumn: Math.max(2, maxColumn) };
  }
  const startColumn = Math.max(1, Math.floor(column));
  return { startColumn, endColumn: Math.max(startColumn + 1, maxColumn) };
}

function compilerMarkers(error: Error | null, source = ''): monaco.editor.IMarkerData[] {
  if (!error) return [];
  const message = error.message || 'Pine compilation failed.';
  // PineTS/Vela diagnostics use several shapes: "line 3, column 8",
  // "3:8", "(3:8)" and occasionally only "(3)". Parse all of them so
  // Monaco always has a concrete location to underline.
  const pairMatch = message.match(/(?:\(|\[|\bat\s+)?(\d+)\s*[:;,]\s*(\d+)(?:\)|\])?/i);
  const lineMatch = message.match(/\bline\s+(\d+)\b/i)
    ?? message.match(/\bline\s*[:=]?\s*(\d+)\b/i)
    ?? (pairMatch ? [pairMatch[0], pairMatch[1]] : null)
    ?? message.match(/\((\d+)\)/);
  const columnMatch = message.match(/\bcolumn\s*[:=]?\s*(\d+)\b/i)
    ?? (pairMatch ? [pairMatch[0], pairMatch[2]] : null);
  let line = Math.max(1, Number(lineMatch?.[1] ?? 1));
  let column = Math.max(1, Number(columnMatch?.[1] ?? 1));
  if (!lineMatch && source) {
    const identifier = message.match(/(?:undeclared|unknown) identifier\s+["']([^"']+)["']/i)?.[1];
    if (identifier) {
      const identifierMatch = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(source);
      if (identifierMatch) {
        const location = lineColumnAt(source, identifierMatch.index);
        line = location.line;
        column = location.column;
      }
    }
  }
  line = Math.min(line, Math.max(1, source.split(/\r?\n/).length));
  const range = diagnosticRange(source, line, column);
  return [{
	severity: monaco.MarkerSeverity.Error,
	message,
	startLineNumber: line,
	startColumn: range.startColumn,
	endLineNumber: line,
	endColumn: range.endColumn,
  }];
}

function validateModel(model: PineModel): void {
  monaco.editor.setModelMarkers(model, syntaxOwner, staticMarkers(model.getValue()));
  monaco.editor.setModelMarkers(model, runtimeOwner, []);
}

function staticMarkers(source: string): monaco.editor.IMarkerData[] {
  const lines = source.split(/\r?\n/);
  return validatePineStaticSource(source).map(diagnostic => {
    const line = Math.min(diagnostic.line, Math.max(1, lines.length));
    const lineEnd = Math.max(2, (lines[line - 1]?.length ?? 0) + 1);
    const startColumn = Math.min(diagnostic.column, lineEnd - 1);
    return {
      severity: diagnostic.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : diagnostic.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
      message: diagnostic.message,
      source: diagnostic.source,
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn: Math.min(lineEnd, startColumn + diagnostic.length),
    };
  });
}

function findReferenceAtPosition(model: PineModel, position: monaco.Position): { entry: PineReferenceEntry; range: monaco.Range } | undefined {
  const line = model.getLineContent(position.lineNumber);
  const tokenPattern = /[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/g;
  for (const match of line.matchAll(tokenPattern)) {
	const start = (match.index ?? 0) + 1;
	const end = start + match[0].length;
	if (position.column < start || position.column > end + 1) continue;
	const entry = pineReference.find(item => item.name === match[0]);
	if (!entry) continue;
	return {
	  entry,
	  range: new monaco.Range(position.lineNumber, start, position.lineNumber, end),
	};
  }
  return undefined;
}

export function createPineModel(uri: string, value: string): PineModel {
  configurePineLanguage();
  const resource = monaco.Uri.parse(uri);
  const existing = monaco.editor.getModel(resource);
  if (existing) {
	if (existing.getValue() !== value) existing.setValue(value);
	validateModel(existing);
	return existing;
  }
  const model = monaco.editor.createModel(value, pineLanguageId, resource);
  model.onDidChangeContent(() => validateModel(model));
  model.onWillDispose(() => {
	monaco.editor.setModelMarkers(model, syntaxOwner, []);
	monaco.editor.setModelMarkers(model, runtimeOwner, []);
  });
  validateModel(model);
  return model;
}

export function createPineEditor(host: HTMLElement, model: PineModel, theme: 'dark' | 'light'): PineEditor {
  configurePineLanguage();
  monaco.editor.setTheme(theme === 'dark' ? 'pine-dark' : 'pine-light');
  let fontSize = savedEditorFontSize();
  const editor = monaco.editor.create(host, {
	model,
	automaticLayout: true,
	theme: theme === 'dark' ? 'pine-dark' : 'pine-light',
	fontFamily: 'Consolas, "Cascadia Code", monospace',
	fontSize,
	lineHeight: Math.round(fontSize * 1.6),
	tabSize: 2,
	insertSpaces: true,
	minimap: { enabled: false },
	folding: true,
	glyphMargin: true,
	lineNumbers: 'on',
	renderLineHighlight: 'all',
	scrollBeyondLastLine: false,
	smoothScrolling: true,
	wordWrap: 'off',
	quickSuggestions: true,
	suggestOnTriggerCharacters: true,
	parameterHints: { enabled: true },
	hover: { enabled: 'on', delay: 250 },
	bracketPairColorization: { enabled: true },
	mouseWheelZoom: false,
  });
  host.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextSize = Math.max(10, Math.min(30, fontSize + direction));
    if (nextSize === fontSize) return;
    fontSize = nextSize;
    localStorage.setItem(editorFontSizeStorageKey, String(fontSize));
    editor.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.6) });
  }, { passive: false, capture: true });
  return editor;
}

export function getPineReferenceNameAtPosition(model: PineModel, position: monaco.Position): string | null {
  return findReferenceAtPosition(model, position)?.entry.name ?? null;
}

function inferExpressionType(expression: string, explicitType?: string): string {
  if (explicitType) return explicitType;
  const value = expression.trim();
  if (/^(true|false)\b/.test(value) || /(?:==|!=|<=|>=|<|>|\band\b|\bor\b|\bnot\b)/.test(value)) return 'series bool';
  if (/^["']/.test(value)) return 'string';
  if (/^color\./.test(value)) return 'color';
  if (/^input\.int\s*\(/.test(value)) return 'input int';
  if (/^input\.(?:float|price)\s*\(/.test(value)) return 'input float';
  if (/^input\.bool\s*\(/.test(value)) return 'input bool';
  if (/^input\.(?:string|symbol|timeframe|session)\s*\(/.test(value)) return 'input string';
  if (/^-?\d+$/.test(value)) return 'int';
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return 'float';
  if (/^(?:open|high|low|close|volume|hl2|hlc3|ohlc4)\b/.test(value) || /^(?:ta|math)\./.test(value)) return 'series float';
  return 'series / inferred at runtime';
}

function displayExpressionValue(expression: string): string {
  const value = expression.trim().replace(/\s+/g, ' ');
  const inputDefault = value.match(/^input\.\w+\s*\(\s*([^,)]+)/)?.[1];
  if (inputDefault) return inputDefault.trim();
  if (/^(?:true|false|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')$/.test(value)) return value;
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

function variableHover(model: PineModel, position: monaco.Position): monaco.languages.Hover | undefined {
  const word = model.getWordAtPosition(position);
  if (!word) return undefined;
  const name = word.word;
  const sourceBeforePosition = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber)));
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`^\\s*(?:(var|varip)\\s+)?(?:(int|float|bool|string|color)\\s+)?${escapedName}\\s*(?::=|=)\\s*(.+)$`, 'gm');
  let latest: RegExpExecArray | null = null;
  for (let candidate = declaration.exec(sourceBeforePosition); candidate; candidate = declaration.exec(sourceBeforePosition)) latest = candidate;

  const builtinTypes: Record<string, string> = {
    open: 'series float', high: 'series float', low: 'series float', close: 'series float', volume: 'series float',
    hl2: 'series float', hlc3: 'series float', ohlc4: 'series float', bar_index: 'series int', time: 'series int',
  };
  if (!latest && !builtinTypes[name]) return undefined;

  const expression = latest?.[3]?.replace(/\/\/.*$/, '').trim();
  const type = builtinTypes[name] ?? inferExpressionType(expression ?? '', latest?.[2]);
  const qualifier = latest?.[1] ? `${latest[1]} ` : '';
  const details = expression
    ? `**Type:** \`${qualifier}${type}\`\n\n**Value / expression:** \`${displayExpressionValue(expression)}\``
    : `**Type:** \`${type}\`\n\n**Value:** provided by the current chart bar at runtime`;
  return {
    range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
    contents: [{ value: `**${name}**\n\n${details}` }],
  };
}

export interface PineSyntaxDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  source: string;
}

export function getPineSyntaxDiagnostics(model: PineModel): PineSyntaxDiagnostic[] {
  return validatePineStaticSource(model.getValue());
}

export function setPineEditorTheme(theme: 'dark' | 'light'): void {
  configurePineLanguage();
  monaco.editor.setTheme(theme === 'dark' ? 'pine-dark' : 'pine-light');
}

export function setPineDiagnostics(model: PineModel, error: Error | null): void {
  monaco.editor.setModelMarkers(model, runtimeOwner, compilerMarkers(error, model.getValue()));
}

export function setPinePreviewDiagnostics(model: PineModel, error: Error | null): void {
  const markers = compilerMarkers(error, model.getValue()).map(marker => ({
    ...marker,
    severity: monaco.MarkerSeverity.Warning,
    source: 'PineTS sample-data check (not TradingView compile)',
    message: `PineTS sample-data check: ${marker.message}`,
  }));
  monaco.editor.setModelMarkers(model, runtimeOwner, markers);
}

export function setPineCompileDiagnostics(model: PineModel, error: Error | null): void {
  setPineDiagnostics(model, error);
}

configurePineLanguage();
