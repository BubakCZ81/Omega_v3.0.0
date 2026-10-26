import { registerIcon, registerSidePanel, type SidePanelHandle, type Vela } from '@luxalgo/vela';

interface NewsArticle {
  id: string;
  title: string;
  publisher: string;
  link: string;
  publishedAt: number;
  relatedTickers: string[];
}

declare global {
  interface Window {
    velaNews?: {
      search(symbol: string): Promise<NewsArticle[]>;
      open(url: string): Promise<boolean>;
    };
  }
}

const panelStyles = `
  .omega-news { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--vela-fg,#d1d4dc); background:var(--vela-bg,#131722); font:12px/1.45 sans-serif; }
  .omega-news-status { padding:9px 11px; color:var(--vela-muted,#9ca3af); border-bottom:1px solid var(--vela-border,#2a2e39); }
  .omega-news-list { overflow:auto; flex:1; }
  .omega-news-item { display:block; padding:11px; border-bottom:1px solid var(--vela-border,#2a2e39); color:inherit; text-decoration:none; }
  .omega-news-item:hover { background:var(--vela-hover,#1e222d); }
  .omega-news-title { margin:0 0 6px; color:var(--vela-fg-bright,#f1f5f9); font-size:12px; font-weight:600; }
  .omega-news-meta { display:flex; justify-content:space-between; gap:8px; color:var(--vela-muted,#9ca3af); font-size:10px; }
  .omega-news-empty { padding:16px 11px; color:var(--vela-muted,#9ca3af); }
`;

function formatPublishedAt(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  const age = Date.now() - timestamp;
  if (age >= 0 && age < 60 * 60_000) {
    const minutes = Math.max(1, Math.floor(age / 60_000));
    return `${minutes}m ago`;
  }
  if (age >= 0 && age < 24 * 60 * 60_000) {
    return `${Math.floor(age / (60 * 60_000))}h ago`;
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function currentSymbol(chart: Vela | null): string {
  return chart?.market.symbol?.trim() || '';
}

function newsQueryForSymbol(symbol: string): string {
  return symbol.includes(':') ? symbol.slice(symbol.lastIndexOf(':') + 1) : symbol;
}

function renderNewsList(list: HTMLElement, articles: NewsArticle[]) {
  list.replaceChildren();
  if (articles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'omega-news-empty';
    empty.textContent = 'No recent headlines were found for this symbol.';
    list.append(empty);
    return;
  }

  for (const article of articles) {
    const link = document.createElement('a');
    link.className = 'omega-news-item';
    link.href = article.link;
    link.rel = 'noopener noreferrer';
    link.target = '_blank';
    link.setAttribute('aria-label', `${article.title} — ${article.publisher}`);
    link.addEventListener('click', event => {
      event.preventDefault();
      if (window.velaNews) {
        void window.velaNews.open(article.link).catch(error => console.error('Could not open news article:', error));
      } else {
        window.open(article.link, '_blank', 'noopener,noreferrer');
      }
    });

    const title = document.createElement('div');
    title.className = 'omega-news-title';
    title.textContent = article.title;
    const meta = document.createElement('div');
    meta.className = 'omega-news-meta';
    const publisher = document.createElement('span');
    publisher.textContent = article.publisher;
    const time = document.createElement('time');
    time.dateTime = new Date(article.publishedAt).toISOString();
    time.textContent = formatPublishedAt(article.publishedAt);
    meta.append(publisher, time);
    link.append(title, meta);
    list.append(link);
  }
}

registerIcon(
  'omega-news',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 1 4 16.5z"/><path d="M4 16.5A2.5 2.5 0 0 1 6.5 14H20M8 7h8M8 10h8"/></svg>',
);

registerSidePanel({
  id: 'omega-news',
  title: 'Market News',
  icon: 'omega-news',
  order: 75,
  width: 340,
  resizable: true,
  minWidth: 260,
  maxWidth: 520,
  mount(_context, body, header) {
    const style = document.createElement('style');
    style.textContent = panelStyles;
    document.head.append(style);

    const root = document.createElement('section');
    root.className = 'omega-news';
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--vela-border,#2a2e39)';
    const symbolLabel = document.createElement('strong');
    symbolLabel.textContent = 'Current symbol';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'vela-button';
    refresh.textContent = 'Refresh';
    refresh.setAttribute('aria-label', 'Refresh market news');
    controls.append(symbolLabel, refresh);
    const status = document.createElement('div');
    status.className = 'omega-news-status';
    status.setAttribute('role', 'status');
    const list = document.createElement('div');
    list.className = 'omega-news-list';
    root.append(controls, status, list);
    body.replaceChildren(root);

    let chart: Vela | null = null;
    let generation = 0;
    let unsubscribe: (() => void) | null = null;

    const refreshNews = async () => {
      const symbol = currentSymbol(chart);
      const requestId = ++generation;
      header.setTitle(symbol ? `Market News — ${symbol}` : 'Market News');
      symbolLabel.textContent = symbol || 'No chart symbol';
      if (!symbol) {
        status.textContent = 'Select a chart symbol to view related headlines.';
        list.replaceChildren();
        return;
      }
      status.textContent = `Loading recent headlines for ${symbol}…`;
      refresh.disabled = true;
      try {
        const articles = window.velaNews
          ? await window.velaNews.search(newsQueryForSymbol(symbol))
          : await fetchDevNews(newsQueryForSymbol(symbol));
        if (requestId !== generation || currentSymbol(chart) !== symbol) return;
        renderNewsList(list, articles);
        status.textContent = `Recent headlines for ${symbol} · ${new Date().toLocaleTimeString()}`;
      } catch (error) {
        if (requestId !== generation) return;
        status.textContent = `Could not load news: ${error instanceof Error ? error.message : String(error)}`;
        list.replaceChildren();
      } finally {
        if (requestId === generation) refresh.disabled = false;
      }
    };

    const bindChart = (next: Vela) => {
      unsubscribe?.();
      chart = next;
      unsubscribe = chart.on('market:changed', () => void refreshNews());
      if (currentSymbol(chart)) void refreshNews();
    };

    refresh.addEventListener('click', () => void refreshNews());
    return {
      onChart: bindChart,
      onOpen: () => void refreshNews(),
      destroy() {
        generation += 1;
        unsubscribe?.();
        style.remove();
        root.remove();
      },
    } satisfies SidePanelHandle;
  },
});

async function fetchDevNews(symbol: string): Promise<NewsArticle[]> {
  const params = new URLSearchParams({ q: symbol, newsCount: '30', quotesCount: '0' });
  const response = await fetch(`/api/yahoo/v1/finance/search?${params}`);
  if (!response.ok) throw new Error(`News provider returned HTTP ${response.status}.`);
  const result = await response.json() as { news?: Array<Record<string, unknown>> };
  if (!Array.isArray(result.news)) throw new Error('News provider returned an invalid response.');
  return result.news.flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.publisher !== 'string' || typeof item.link !== 'string') return [];
    const publishedAt = Number(item.providerPublishTime) * 1000;
    if (!Number.isFinite(publishedAt) || !item.link.startsWith('https://')) return [];
    return [{
      id: typeof item.uuid === 'string' ? item.uuid : item.link,
      title: item.title,
      publisher: item.publisher,
      link: item.link,
      publishedAt,
      relatedTickers: Array.isArray(item.relatedTickers) ? item.relatedTickers.filter((ticker): ticker is string => typeof ticker === 'string') : [],
    }];
  });
}
