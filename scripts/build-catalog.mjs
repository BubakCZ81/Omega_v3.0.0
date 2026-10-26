/**
 * Build the indicator picker catalog from Pine sources that execute in PineTS.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PineTS } from 'pinets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evergetDir = path.join(root, 'public', 'indicators', 'everget');
const compatibleDir = path.join(evergetDir, 'compatible');
const indicatorDir = path.join(root, 'public', 'indicators');
const editorsPickDir = path.join(indicatorDir, "Editor's Pick");
const catalogPath = path.join(root, 'public', 'indicators', 'catalog.json');

const categoryMap = {
  bands_and_channels: 'Bands & Channels',
  highlighters: 'Highlighters',
  movings: 'Moving Averages',
  oscillators: 'Oscillators',
  research: 'Research',
  statistics: 'Statistics',
  trailing_stops: 'Trailing Stops',
  utils: 'Utilities',
  volatility: 'Volatility',
  volume: 'Volume',
};

function snakeToTitle(snake) {
  return snake
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bRsi\b/g, 'RSI')
    .replace(/\bEma\b/g, 'EMA')
    .replace(/\bSma\b/g, 'SMA')
    .replace(/\bWma\b/g, 'WMA')
    .replace(/\bMacd\b/g, 'MACD')
    .replace(/\bCci\b/g, 'CCI')
    .replace(/\bMfi\b/g, 'MFI')
    .replace(/\bObv\b/g, 'OBV')
    .replace(/\bAtr\b/g, 'ATR')
    .replace(/\bTsi\b/g, 'TSI')
    .replace(/\bStc\b/g, 'STC')
    .replace(/\bPnf\b/g, 'PNF')
    .replace(/\bDps\b/g, 'DPS')
    .replace(/\bEps\b/g, 'EPS')
    .replace(/\bRoi\b/g, 'ROI')
    .replace(/\bYtd\b/g, 'YTD')
    .replace(/\bUtc\b/g, 'UTC')
    .replace(/\bVw\b/g, 'VW')
    .replace(/\bNrtr\b/g, 'NRTR')
    .replace(/\bSar\b/g, 'SAR')
    .replace(/\bUs\b/g, 'US')
    .replace(/\bAth\b/g, 'ATH')
    .replace(/\bVidya\b/g, 'VIDYA')
    .replace(/\bDmi\b/g, 'DMI')
    .replace(/\bVs\b/g, 'vs');
}

function listPineFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const full = path.join(directory, item.name);
    return item.isDirectory() ? listPineFiles(full) : item.name.endsWith('.pine') ? [full] : [];
  });
}

const bars = Array.from({ length: 500 }, (_, index) => {
  const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
  const open = close + Math.sin(index) * 0.3;
  return {
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 100 + index % 17,
    openTime: 1_700_000_000_000 + index * 60_000,
  };
});
const originalCandidates = listPineFiles(evergetDir)
  .filter(file => !path.relative(evergetDir, file).startsWith(`compatible${path.sep}`));
const candidates = [...originalCandidates, ...listPineFiles(compatibleDir)]
  .sort((a, b) => {
    const aOriginal = !path.relative(evergetDir, a).startsWith(`compatible${path.sep}`);
    const bOriginal = !path.relative(evergetDir, b).startsWith(`compatible${path.sep}`);
    return Number(bOriginal) - Number(aOriginal) || a.localeCompare(b);
  });
const catalog = [];
const seen = new Set();
let failedCount = 0;

for (const file of candidates) {
  const relativePath = path.relative(evergetDir, file).replace(/\\/g, '/');
  const baseName = path.basename(file, '.pine');
  const name = snakeToTitle(baseName);
  if (seen.has(name)) continue;
  const source = fs.readFileSync(file, 'utf8');
  try {
    await new PineTS(bars).run(source);
  } catch (error) {
    failedCount++;
    console.warn(`Skipping ${relativePath}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    continue;
  }
  seen.add(name);
  const categoryFolder = relativePath.split('/').at(-2) ?? 'other';
  catalog.push({
    name,
    url: `/indicators/everget/${relativePath}`,
    language: 'pine',
    enabled: false,
    category: categoryMap[categoryFolder] || snakeToTitle(categoryFolder),
  });
}

for (const category of fs.readdirSync(editorsPickDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const manifestPath = path.join(editorsPickDir, category.name, 'catalog.json');
  if (!fs.existsSync(manifestPath)) continue;
  const featuredEntries = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const featured of featuredEntries) {
    if (featured.license !== 'GPL-3.0' || !featured.source || !featured.sourceUrl ||
        !featured.subcategory || featured.subcategory !== category.name || !featured.licenseFile) {
      throw new Error(`Invalid Editor's Pick metadata in ${path.relative(editorsPickDir, manifestPath)}.`);
    }
    const sourceRelativePath = decodeURIComponent(new URL(featured.source, 'http://localhost').pathname)
      .replace(/^\/indicators\//, '');
    const sourcePath = path.resolve(indicatorDir, sourceRelativePath);
    if (!sourcePath.startsWith(`${indicatorDir}${path.sep}`)) {
      throw new Error(`Editor's Pick source escapes the indicator library: ${featured.source}`);
    }
    const source = fs.readFileSync(sourcePath, 'utf8');
    if (!/GPL-3\.0 license/i.test(source)) {
      throw new Error(`Editor's Pick source does not declare GPL-3.0: ${featured.source}`);
    }
    const licensePath = path.resolve(indicatorDir, featured.licenseFile);
    if (!licensePath.startsWith(`${indicatorDir}${path.sep}`) ||
        !fs.readFileSync(licensePath, 'utf8').includes('GNU GENERAL PUBLIC LICENSE')) {
      throw new Error(`Editor's Pick GPL-3.0 license notice is missing for ${featured.name}.`);
    }
    await new PineTS(bars).run(source);
    const catalogEntry = catalog.find(entry => entry.url === featured.source);
    if (!catalogEntry) {
      throw new Error(`Editor’s Pick source is not in the verified catalog: ${featured.source}`);
    }
    if (catalogEntry.name !== featured.name && catalog.some(entry => entry.name === featured.name)) {
      throw new Error(`Editor’s Pick name is already in use: ${featured.name}`);
    }
    catalogEntry.name = featured.name;
    catalogEntry.collections = [...new Set([
      ...(catalogEntry.collections ?? []),
      `Editor's Pick / ${featured.subcategory}`,
    ])];
  }
}

catalog.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Generated alphabetized catalog with ${catalog.length} verified indicators (${failedCount} sources still fail PineTS runtime validation).`);
