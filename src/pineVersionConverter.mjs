const FUNCTION_NAMESPACES = new Map([
  ['abs', 'math.abs'], ['acos', 'math.acos'], ['asin', 'math.asin'], ['atan', 'math.atan'],
  ['ceil', 'math.ceil'], ['exp', 'math.exp'], ['floor', 'math.floor'], ['log', 'math.log'],
  ['log10', 'math.log10'], ['max', 'math.max'], ['min', 'math.min'], ['pow', 'math.pow'],
  ['round', 'math.round'], ['sign', 'math.sign'], ['sqrt', 'math.sqrt'],
  ['ema', 'ta.ema'], ['rma', 'ta.rma'], ['sma', 'ta.sma'], ['wma', 'ta.wma'],
  ['vwma', 'ta.vwma'], ['hma', 'ta.hma'], ['alma', 'ta.alma'], ['atr', 'ta.atr'],
  ['tr', 'ta.tr'], ['rsi', 'ta.rsi'], ['macd', 'ta.macd'], ['stoch', 'ta.stoch'],
  ['cci', 'ta.cci'], ['mfi', 'ta.mfi'], ['mom', 'ta.mom'], ['roc', 'ta.roc'],
  ['change', 'ta.change'], ['cum', 'ta.cum'], ['highest', 'ta.highest'], ['lowest', 'ta.lowest'],
  ['highestbars', 'ta.highestbars'], ['lowestbars', 'ta.lowestbars'], ['median', 'ta.median'],
  ['stdev', 'ta.stdev'], ['variance', 'ta.variance'], ['valuewhen', 'ta.valuewhen'],
  ['barssince', 'ta.barssince'], ['linreg', 'ta.linreg'], ['correlation', 'ta.correlation'],
  ['cross', 'ta.cross'], ['crossover', 'ta.crossover'], ['crossunder', 'ta.crossunder'],
  ['pivothigh', 'ta.pivothigh'], ['pivotlow', 'ta.pivotlow'],
  ['security', 'request.security'], ['security_lower_tf', 'request.security_lower_tf'],
]);

const INPUT_TYPES = new Map([
  ['integer', 'int'], ['int', 'int'], ['float', 'float'], ['bool', 'bool'],
  ['string', 'string'], ['source', 'source'], ['resolution', 'timeframe'],
  ['timeframe', 'timeframe'], ['symbol', 'symbol'], ['time', 'time'],
]);

const COLORS = new Set([
  'red', 'green', 'blue', 'orange', 'yellow', 'purple', 'white', 'black', 'silver',
  'gray', 'olive', 'lime', 'teal', 'aqua', 'navy', 'maroon', 'fuchsia',
]);

function skipTrivia(source, index) {
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
    } else if (source[index] === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      return newline < 0 ? source.length : skipTrivia(source, newline + 1);
    } else {
      break;
    }
  }
  return index;
}

function matchingClose(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      if (newline < 0) return -1;
      index = newline;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitArguments(source) {
  const result = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function findUnsupportedLegacySyntax(source) {
  let inString = null;
  let inComment = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '\n') {
      inComment = false;
      index += 1;
      continue;
    }
    if (inComment) {
      index += 1;
      continue;
    }
    if (inString) {
      if (character === '\\') index += 2;
      else {
        if (character === inString) inString = null;
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      inComment = true;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      inString = character;
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      while (/[A-Za-z0-9_]/.test(source[index] || '')) index += 1;
      const identifier = source.slice(start, index);
      const nextCode = skipTrivia(source, index);
      if (identifier === 'iff' && source[nextCode] === '(') return 'The legacy iff() function needs a manual conditional rewrite.';
      if ((identifier === 'transp' || identifier === 'when') && source[skipTrivia(source, index)] === '=') {
        return `The legacy ${identifier}= argument needs a manual Pine v6 rewrite.`;
      }
      continue;
    }
    index += 1;
  }
  return null;
}

function convertInputCall(source, identifierStart, openIndex, closeIndex) {
  const args = splitArguments(source.slice(openIndex + 1, closeIndex));
  const namedTypeIndex = args.findIndex(argument => /^type\s*=/.test(argument));
  const typeIndex = namedTypeIndex >= 0 ? namedTypeIndex : (args.length > 2 && !args[2].includes('=') ? 2 : -1);
  if (typeIndex < 0) return null;
  const typeArgument = args[typeIndex];
  const rawType = (namedTypeIndex >= 0 ? typeArgument.slice(typeArgument.indexOf('=') + 1) : typeArgument).trim();
  const typeMatch = rawType.match(/^(?:input\.)?([A-Za-z_]\w*)$/);
  const inputType = INPUT_TYPES.get(typeMatch?.[1] ?? '');
  if (!inputType) throw new Error(`Cannot safely convert legacy input type "${rawType}".`);
  args.splice(typeIndex, 1);
  return {
    start: identifierStart,
    end: closeIndex + 1,
    replacement: `input.${inputType}(${args.join(', ')})`,
  };
}

function isCodeIdentifierStart(character) {
  return /[A-Za-z_]/.test(character || '');
}

function isCodeIdentifierPart(character) {
  return /[A-Za-z0-9_]/.test(character || '');
}

function convertCode(source) {
  const edits = [];
  const userFunctions = new Set([...source.matchAll(/^\s*([A-Za-z_]\w*)\s*\([^()\r\n]*\)\s*=>/gm)]
    .map(match => match[1]));
  let inString = null;
  let inComment = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '\n') {
      inComment = false;
      index += 1;
      continue;
    }
    if (inComment) {
      index += 1;
      continue;
    }
    if (inString) {
      if (character === '\\') index += 2;
      else {
        if (character === inString) inString = null;
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      inComment = true;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      inString = character;
      index += 1;
      continue;
    }
    if (!isCodeIdentifierStart(character)) {
      index += 1;
      continue;
    }

    const start = index;
    while (isCodeIdentifierPart(source[index])) index += 1;
    const identifier = source.slice(start, index);
    const openIndex = skipTrivia(source, index);
    const previousIndex = start - 1;
    const isNamespaced = source[previousIndex] === '.';

    if (identifier === 'input' && source[openIndex] === '(' && !isNamespaced) {
      const closeIndex = matchingClose(source, openIndex);
      if (closeIndex < 0) throw new Error('The legacy input() call has unmatched parentheses.');
      const edit = convertInputCall(source, start, openIndex, closeIndex);
      if (edit) {
        edits.push(edit);
        index = closeIndex + 1;
      }
      continue;
    }

    let replacement;
    if (identifier === 'study' && source[openIndex] === '(' && !isNamespaced) {
      replacement = 'indicator';
    } else if (FUNCTION_NAMESPACES.has(identifier) && !userFunctions.has(identifier)
      && source[openIndex] === '(' && !isNamespaced) {
      replacement = FUNCTION_NAMESPACES.get(identifier);
    } else if (identifier === 'tickerid' && !isNamespaced) {
      replacement = 'syminfo.tickerid';
    } else if (identifier === 'ticker' && !isNamespaced && source[openIndex] !== '(') {
      replacement = 'syminfo.ticker';
    } else if (identifier === 'period' && !isNamespaced) {
      replacement = 'timeframe.period';
    } else if (COLORS.has(identifier) && !isNamespaced
      && ['=', ',', '('].includes(source.slice(0, start).trimEnd().at(-1))) {
      replacement = `color.${identifier}`;
    } else if (identifier === 'columns' && !isNamespaced
      && ['=', ','].includes(source.slice(0, start).trimEnd().at(-1))) {
      replacement = 'plot.style_columns';
    }

    if (replacement) edits.push({ start, end: index, replacement });
  }

  let output = source;
  for (const edit of edits.reverse()) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

export function convertPineScriptToV6(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The editor is empty.');
  const directives = [...source.matchAll(/^\s*\/\/@version\s*=\s*(\d+)\s*$/gm)];
  if (directives.length !== 1) throw new Error('Could not detect exactly one Pine version directive.');

  const version = Number(directives[0][1]);
  if (![3, 4, 5].includes(version)) {
    if (version === 6) throw new Error('This script already uses Pine Script v6.');
    throw new Error(`Pine Script v${version} is not supported by the upgrader.`);
  }

  const unsupportedSyntax = findUnsupportedLegacySyntax(source);
  if (unsupportedSyntax) throw new Error(unsupportedSyntax);

  const directive = directives[0];
  const withV6Directive = source.slice(0, directive.index)
    + directive[0].replace(/\/\/@version\s*=\s*\d+/, '//@version=6')
    + source.slice(directive.index + directive[0].length);
  const converted = convertCode(withV6Directive);
  if (!/^\s*(indicator|strategy|library)\s*\(/m.test(converted)) {
    throw new Error('The script has no indicator(), strategy(), or library() declaration.');
  }
  return { source: converted, version, changes: converted === source ? 0 : 1 };
}
