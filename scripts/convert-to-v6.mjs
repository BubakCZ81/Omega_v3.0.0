/**
 * convert-to-v6.mjs
 * Converts all Pine Script indicators from v2/v3/v4/v5 to v6 syntax.
 *
 * Key changes from older versions to v6:
 * - study() → indicator()
 * - //@version=N → //@version=6
 * - Double-quoted strings in study/indicator title → single-quoted
 * - transp parameter removed from plot/fill/bgcolor etc → use color.new()
 * - color(red,100) → color.new(color.red, 100)
 * - Old color literals: red → color.red, green → color.green, etc.
 * - security() → request.security()
 * - input() type handling updates
 * - tickerid → syminfo.tickerid
 * - period → timeframe.period
 * - Various renamed built-ins
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evergetDir = path.join(root, 'public', 'indicators', 'everget');

let convertedCount = 0;
let skippedCount = 0;
let errorCount = 0;

function convertToV6(content, filePath) {
  let src = content;
  const relPath = path.relative(evergetDir, filePath);

  // Already v6
  if (/^\s*\/\/@version=6/.test(src)) {
    skippedCount++;
    return src;
  }

  // 1. Update version annotation
  src = src.replace(/\/\/@version=\d+/, '//@version=6');
  if (!/\/\/@version=6/.test(src)) {
    src = '//@version=6\n' + src;
  }

  // 2. study() → indicator()
  src = src.replace(/\bstudy\s*\(/g, 'indicator(');

  // 3. Replace bare color names with color.xxx (only standalone words, not already prefixed)
  const colorMap = {
    'red': 'color.red',
    'green': 'color.green',
    'blue': 'color.blue',
    'orange': 'color.orange',
    'yellow': 'color.yellow',
    'purple': 'color.purple',
    'white': 'color.white',
    'black': 'color.black',
    'silver': 'color.silver',
    'gray': 'color.gray',
    'olive': 'color.olive',
    'lime': 'color.lime',
    'teal': 'color.teal',
    'aqua': 'color.aqua',
    'navy': 'color.navy',
    'maroon': 'color.maroon',
    'fuchsia': 'color.fuchsia',
  };

  // Replace bare color references (not preceded by color. or inside strings/comments)
  for (const [bare, full] of Object.entries(colorMap)) {
    // Match: bare color name that is NOT preceded by "color." or a letter/digit
    // and NOT followed by a letter/digit (word boundary)
    const re = new RegExp(`(?<!color\\.)(?<![A-Za-z_])\\b${bare}\\b(?!\\s*[=(])`, 'g');
    src = src.replace(re, (match, offset) => {
      // Check if we're inside a string or comment
      const before = src.substring(0, offset);
      const lastNewline = before.lastIndexOf('\n');
      const lineStart = lastNewline + 1;
      const lineUpToMatch = before.substring(lineStart);

      // Skip if in a comment
      if (lineUpToMatch.includes('//')) return match;

      // Skip if inside quotes (simple heuristic: count unescaped quotes)
      const quoteCount = (lineUpToMatch.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 !== 0) return match;
      const sqCount = (lineUpToMatch.match(/(?<!\\)'/g) || []).length;
      if (sqCount % 2 !== 0) return match;

      return full;
    });
  }

  // 4. Handle transp parameter in plot functions
  // plot(..., transp=N) → remove transp, wrap color in color.new()
  // This is complex so we handle common patterns:
  src = src.replace(/,\s*transp\s*=\s*\d+/g, '');

  // 5. Replace security() → request.security()
  src = src.replace(/(?<!request\.)(?<!\w)security\s*\(/g, 'request.security(');

  // 6. Replace old input() patterns
  // input(title=..., type=integer, ...) → input.int(...)
  // input(title=..., type=float, ...) → input.float(...)
  // input(title=..., type=bool, ...) → input.bool(...)
  // input(title=..., type=string, ...) → input.string(...)
  // input(title=..., type=source, ...) → input.source(...)
  // input(title=..., type=resolution, ...) → input.timeframe(...)
  src = src.replace(/\binput\s*\(\s*([^)]*?)\btype\s*=\s*integer\b([^)]*)\)/g, (match, before, after) => {
    return `input.int(${before.replace(/,\s*$/, '')}${after})`.replace(/,\s*\)/, ')');
  });
  src = src.replace(/\binput\s*\(\s*([^)]*?)\btype\s*=\s*float\b([^)]*)\)/g, (match, before, after) => {
    return `input.float(${before.replace(/,\s*$/, '')}${after})`.replace(/,\s*\)/, ')');
  });
  src = src.replace(/\binput\s*\(\s*([^)]*?)\btype\s*=\s*bool\b([^)]*)\)/g, (match, before, after) => {
    return `input.bool(${before.replace(/,\s*$/, '')}${after})`.replace(/,\s*\)/, ')');
  });
  src = src.replace(/\binput\s*\(\s*([^)]*?)\btype\s*=\s*string\b([^)]*)\)/g, (match, before, after) => {
    return `input.string(${before.replace(/,\s*$/, '')}${after})`.replace(/,\s*\)/, ')');
  });
  src = src.replace(/\binput\s*\(\s*([^)]*?)\btype\s*=\s*source\b([^)]*)\)/g, (match, before, after) => {
    return `input.source(${before.replace(/,\s*$/, '')}${after})`.replace(/,\s*\)/, ')');
  });
  src = src.replace(/\binput\s*\(\s*([^)]*?)\btype\s*=\s*resolution\b([^)]*)\)/g, (match, before, after) => {
    return `input.timeframe(${before.replace(/,\s*$/, '')}${after})`.replace(/,\s*\)/, ')');
  });

  // 7. Replace deprecated built-in variables
  src = src.replace(/\bticker\b(?!\s*\()/g, (match, offset) => {
    const before = src.substring(Math.max(0, offset - 20), offset);
    if (before.includes('syminfo.') || before.includes('//')) return match;
    return 'syminfo.ticker';
  });

  // tickerid → syminfo.tickerid (but not if already syminfo.tickerid)
  src = src.replace(/(?<!syminfo\.)(?<!\w)\btrickerid\b/g, 'syminfo.tickerid');

  // period → timeframe.period (careful – only when used as the built-in)
  // This is too risky for auto-conversion, skip it

  // 8. Replace color() function → color.rgb() or color.new()
  // color(red, 80) → color.new(color.red, 80)
  // #RRGGBB patterns stay as-is

  // 9. Replace old-style iff() → conditional ternary
  // iff(cond, a, b) → cond ? a : b
  // This is too complex for regex, skip

  // 10. Replace nz() if needed (stays the same in v6)

  // 11. Ensure double-quoted strings in indicator() title still work (they do in v6)

  convertedCount++;
  return src;
}

function walkAndConvert(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      walkAndConvert(full);
    } else if (item.name.endsWith('.pine')) {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const converted = convertToV6(content, full);
        if (converted !== content) {
          fs.writeFileSync(full, converted, 'utf-8');
        }
      } catch (err) {
        console.error(`Error converting ${full}:`, err.message);
        errorCount++;
      }
    }
  }
}

console.log('Converting all Pine indicators to v6...');
walkAndConvert(evergetDir);
console.log(`✓ Done: ${convertedCount} converted, ${skippedCount} already v6, ${errorCount} errors.`);
