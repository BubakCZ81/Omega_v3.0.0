import type { PineEditor } from './pineEditorNext';
import { pineReference, type PineReferenceEntry } from './pineReference';
import DOMPurify from 'dompurify';

export interface PineReferencePanel {
  render(filter?: string): void;
  open(name: string): boolean;
}

const referenceFontSizeKey = 'omega.pine-reference.font-size';

function renderManual(entry: PineReferenceEntry, host: HTMLElement, renderList: (filter?: string) => void): void {
  host.replaceChildren();

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'pine-reference-item';
  back.textContent = 'Back to reference list';
  back.classList.add('pine-reference-back');
	back.addEventListener('click', () => {
	const search = document.getElementById('pine-reference-search') as HTMLInputElement | null;
	renderList(search?.value ?? '');
  });
  host.appendChild(back);

  const title = document.createElement('div');
  title.textContent = entry.name;
  title.className = 'pine-reference-manual-title';
  host.appendChild(title);

  const body = document.createElement('div');
  body.className = 'pine-reference-manual';
  const markdown = entry.manual ?? `## ${entry.name}\n\n\`\`\`pine\n${entry.signature}\n\`\`\`\n\n${entry.description}`;
  body.innerHTML = DOMPurify.sanitize(markdown
	.replace(/```pine\n([\s\S]*?)```/g, '<pre class="pine-reference-code pine-reference-pine-code">$1</pre>')
	.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="pine-reference-code">$2</pre>')
	.replace(/^### (.+)$/gm, '<h4 class="pine-reference-subheading">$1</h4>')
	.replace(/^## (.+)$/gm, '<h3 class="pine-reference-heading-text">$1</h3>')
	.replace(/^- \*\*(.+?)\*\*(.*)$/gm, '<div class="pine-reference-list-item"><strong>$1</strong><span>$2</span></div>')
	.replace(/^- (.+)$/gm, '<div class="pine-reference-list-item">- $1</div>')
	.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
	.replace(/`([^`]+)`/g, '<code class="pine-reference-inline-code">$1</code>')
	.replace(/\*(.+?)\*/g, '<em>$1</em>')
	.replace(/\n\n/g, '<br><br>')
	.replace(/---/g, '<hr>')
  );
  host.appendChild(body);
}

export function createPineReferencePanel(getEditor: () => PineEditor | null): PineReferencePanel {
  const panel = document.getElementById('pine-reference');
  const list = document.getElementById('pine-reference-list');
  let referenceFontSize = Math.max(10, Math.min(28, Number(localStorage.getItem(referenceFontSizeKey)) || 13));
  const applyReferenceFontSize = () => panel?.style.setProperty('--pine-reference-font-size', `${referenceFontSize}px`);
  applyReferenceFontSize();

  panel?.addEventListener('wheel', event => {
	if (!event.ctrlKey && !event.metaKey) return;
	event.preventDefault();
	event.stopPropagation();
	const next = Math.max(10, Math.min(28, referenceFontSize + (event.deltaY < 0 ? 1 : -1)));
	if (next === referenceFontSize) return;
	referenceFontSize = next;
	localStorage.setItem(referenceFontSizeKey, String(referenceFontSize));
	applyReferenceFontSize();
  }, { passive: false, capture: true });

  const render = (filter = ''): void => {
	const host = document.getElementById('pine-reference-list');
	if (!host) return;
	const query = filter.trim().toLowerCase();
	const entries = pineReference.filter(entry => !query || `${entry.name} ${entry.signature} ${entry.description} ${entry.category}`.toLowerCase().includes(query));
	host.replaceChildren();

	const grouped = new Map<string, PineReferenceEntry[]>();
	for (const entry of entries) grouped.set(entry.category, [...(grouped.get(entry.category) ?? []), entry]);
	for (const [category, categoryEntries] of grouped) {
	  const heading = document.createElement('div');
	  heading.textContent = category;
	  heading.className = 'pine-reference-category';
	  host.appendChild(heading);

	  for (const entry of categoryEntries) {
		const item = document.createElement('button');
		item.type = 'button';
		item.className = 'pine-reference-item';
		item.title = entry.manual ? 'Double-click for full documentation' : entry.description;
		const name = document.createElement('strong');
		name.textContent = entry.name;
		const signature = document.createElement('code');
		signature.textContent = entry.signature;
		const description = document.createElement('span');
		description.textContent = entry.description;
		const categoryLabel = document.createElement('small');
		categoryLabel.textContent = entry.category;
		item.append(name, signature, description, categoryLabel);
		item.addEventListener('click', event => {
		  event.preventDefault();
		  event.stopPropagation();
		  const editor = getEditor();
		  if (!editor) return;
		  editor.focus();
		  const insertsCall = entry.signature.includes('(');
		  editor.trigger('pine-reference', 'type', { text: `${entry.name}${insertsCall ? '()' : ''}` });
		  if (insertsCall) {
			const position = editor.getPosition();
			if (position) editor.setPosition({ ...position, column: Math.max(1, position.column - 1) });
		  }
		});
		item.addEventListener('dblclick', event => {
		  event.preventDefault();
		  event.stopPropagation();
		  renderManual(entry, host, render);
		});
		host.appendChild(item);
	  }
	}
	if (!entries.length) host.textContent = 'No matching methods.';
  };

  document.getElementById('pine-reference-search')?.addEventListener('input', event => {
	render((event.currentTarget as HTMLInputElement).value);
  });
  const open = (name: string): boolean => {
	const entry = pineReference.find(candidate => candidate.name === name);
	if (!entry || !list) return false;
	window.dispatchEvent(new CustomEvent('pine-reference:open'));
	renderManual(entry, list, render);
	return true;
  };
  render();
  return { render, open };
}
