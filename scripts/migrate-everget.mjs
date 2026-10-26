import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'public', 'indicators', 'everget');
const destinationRoot = path.join(sourceRoot, 'compatible');
const reportPath = path.join(projectRoot, 'reports', 'everget-migration.json');

async function listPineFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
	const fullPath = path.join(directory, entry.name);
	if (entry.isDirectory()) return listPineFiles(fullPath);
	return entry.name.endsWith('.pine') ? [fullPath] : [];
  }));
  return files.flat();
}

function matchingClose(source, start, open = '(', close = ')') {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
	const character = source[index];
	if (quote) {
	  if (character === quote && source[index - 1] !== '\\') quote = null;
	  continue;
	}
	if (character === '"' || character === "'") {
	  quote = character;
	  continue;
	}
	if (character === open) depth += 1;
	if (character === close) {
	  depth -= 1;
	  if (depth === 0) return index;
	}
  }
  return -1;
}

function splitArguments(argumentsText) {
  const result = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < argumentsText.length; index += 1) {
	const character = argumentsText[index];
	if (quote) {
	  if (character === quote && argumentsText[index - 1] !== '\\') quote = null;
	  continue;
	}
	if (character === '"' || character === "'") {
	  quote = character;
	  continue;
	}
	if ('([{'.includes(character)) depth += 1;
	if (')]}'.includes(character)) depth -= 1;
	if (character === ',' && depth === 0) {
	  result.push(argumentsText.slice(start, index).trim());
	  start = index + 1;
	}
  }
  const last = argumentsText.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function argumentName(argument) {
	const match = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1] ?? null;
}

function argumentValue(argument) {
  const name = argumentName(argument);
  return name ? argument.slice(argument.indexOf('=') + 1).trim() : argument.trim();
}

function convertLegacyInputCalls(source, transforms) {
  let output = '';
  let cursor = 0;
	const inputPattern = /\binput\s*\(/g;
  let match;
  while ((match = inputPattern.exec(source))) {
	const open = source.indexOf('(', match.index);
	const close = matchingClose(source, open);
	if (close < 0) break;
	output += source.slice(cursor, match.index);
	const args = splitArguments(source.slice(open + 1, close));
	const typeArgument = args.find(argument => argumentName(argument) === 'type');
	const typeValue = typeArgument ? argumentValue(typeArgument) : null;
	if (!typeValue || !/^input\.(integer|float|bool|string|source|symbol|time|resolution)$/.test(typeValue)) {
	  output += source.slice(match.index, close + 1);
	  cursor = close + 1;
	  inputPattern.lastIndex = close + 1;
	  continue;
	}
	const type = typeValue.slice('input.'.length);
	const functionName = `input.${type}`;
	const converted = args
	  .filter(argument => argumentName(argument) !== 'type')
	  .map(argument => {
		const name = argumentName(argument);
		if (!name) return argument;
		return `${name}=${argumentValue(argument)}`;
	  })
	  .join(', ');
	output += `${functionName}(${converted})`;
	transforms.push(`input(${type}) -> ${functionName}()`);
	cursor = close + 1;
	inputPattern.lastIndex = close + 1;
  }
  output += source.slice(cursor);
  return output;
}

function namespaceFunctions(source, transforms) {
  const mappings = new Map([
	['abs', 'math.abs'], ['acos', 'math.acos'], ['asin', 'math.asin'], ['atan', 'math.atan'],
	['ceil', 'math.ceil'], ['exp', 'math.exp'], ['floor', 'math.floor'], ['log', 'math.log'],
	['log10', 'math.log10'], ['max', 'math.max'], ['min', 'math.min'], ['pow', 'math.pow'],
	['round', 'math.round'], ['sign', 'math.sign'], ['sqrt', 'math.sqrt'],
	['ema', 'ta.ema'], ['rma', 'ta.rma'], ['sma', 'ta.sma'], ['wma', 'ta.wma'],
	['alma', 'ta.alma'], ['atr', 'ta.atr'], ['change', 'ta.change'], ['cum', 'ta.cum'],
	['highest', 'ta.highest'], ['lowest', 'ta.lowest'], ['highestbars', 'ta.highestbars'],
	['lowestbars', 'ta.lowestbars'], ['median', 'ta.median'], ['stdev', 'ta.stdev'],
	['variance', 'ta.variance'], ['sum', 'math.sum'], ['valuewhen', 'ta.valuewhen'],
	['percentile_nearest_rank', 'ta.percentile_nearest_rank'],
  ]);
  let output = source;
  for (const [name, qualified] of mappings) {
	const pattern = new RegExp(`(?<![.A-Za-z0-9_])${name}\\s*\\(`, 'g');
	const next = output.replace(pattern, `${qualified}(`);
	if (next !== output) transforms.push(`${name}() -> ${qualified}()`);
	output = next;
  }
  return output;
}

function convertSimpleLegacyForms(source, transforms) {
  let output = source;
  const replacements = [
	[/\bcolumns\b/g, 'plot.style_columns'],
	[/\bcross\s*\(/g, 'ta.cross('],
	[/\bcrossover\s*\(/g, 'ta.crossover('],
	[/\bcrossunder\s*\(/g, 'ta.crossunder('],
  ];
  for (const [pattern, replacement] of replacements) {
	const next = output.replace(pattern, replacement);
	if (next !== output) transforms.push(`${pattern} -> ${replacement}`);
	output = next;
  }
  return output;
}

function migrate(source) {
  const transforms = [];
	let output = source.replace(/^\/\/@version=\d+/m, '//@version=6');
  output = convertLegacyInputCalls(output, transforms);
  output = namespaceFunctions(output, transforms);
  output = convertSimpleLegacyForms(output, transforms);
  return { source: output, transforms: [...new Set(transforms)] };
}

const files = (await listPineFiles(sourceRoot)).filter(file => !file.includes(`${path.sep}compatible${path.sep}`));
const report = { generatedAt: new Date().toISOString(), sourceCount: files.length, files: [] };
for (const sourcePath of files) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  const destinationPath = path.join(destinationRoot, relativePath);
  const source = await readFile(sourcePath, 'utf8');
  const migrated = migrate(source);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, migrated.source, 'utf8');
  report.files.push({ source: relativePath.replaceAll(path.sep, '/'), output: path.relative(projectRoot, destinationPath).replaceAll(path.sep, '/'), transforms: migrated.transforms });
}
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Migrated ${report.files.length} Everget source files to ${path.relative(projectRoot, destinationRoot)}.`);
console.log(`Migration report: ${path.relative(projectRoot, reportPath)}`);
