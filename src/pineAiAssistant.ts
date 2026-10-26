import { promptForText } from './pineDialog';

export interface PineAiProviderStatus {
  id: 'local' | 'gemini' | 'groq' | 'openrouter' | 'anthropic' | 'cohere' | 'deepseek' | 'mistral' | 'together';
  name: string;
  configured: boolean;
}

interface PineAiModel {
  id: string;
  name: string;
}

interface PineAiBridge {
  providers(): Promise<PineAiProviderStatus[]>;
  saveKey(provider: PineAiProviderStatus['id'], apiKey: string): Promise<PineAiProviderStatus[]>;
  clearKey(provider: PineAiProviderStatus['id']): Promise<PineAiProviderStatus[]>;
  testKey(provider: PineAiProviderStatus['id'], apiKey?: string): Promise<{
    provider: PineAiProviderStatus['id'];
    models: PineAiModel[];
    defaultModel: string;
    providers: PineAiProviderStatus[];
  }>;
  localConfig(): Promise<{ baseUrl: string; model: string; hasApiKey: boolean }>;
  saveLocalConfig(request: { baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean }): Promise<{ baseUrl: string; model: string; hasApiKey: boolean }>;
  testLocalConfig(request: { baseUrl: string; apiKey?: string }): Promise<{ models: PineAiModel[]; defaultModel: string }>;
  complete(request: {
    provider: PineAiProviderStatus['id'];
    model: string;
    prompt: string;
    source: string;
    scriptName: string;
    useLuxAlgoMcp?: boolean;
  }): Promise<{ text: string; model: string }>;
}

declare global {
  interface Window {
    velaAi?: PineAiBridge;
  }
}

interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AiConversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: AiChatMessage[];
}

export interface PineAiAssistant {
  setStatus(message: string, isError?: boolean): void;
}

export interface PineAiAssistantOptions {
  getCurrentScriptName(): string;
  getEditorValue(): string;
  manageReferenceResize?: boolean;
}

const historyStorageKey = 'omega_pine_ai_conversations';
const defaultModels: Record<PineAiProviderStatus['id'], string> = {
  local: '',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
  anthropic: 'claude-3-5-sonnet-20241022',
  cohere: 'command-r-plus',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
};
const codeBlockPattern = /```([a-zA-Z0-9_-]*)\s*\r?\n([\s\S]*?)```/g;

function newConversationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadConversations(): AiConversation[] {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AiConversation => Boolean(item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.title === 'string' && Number.isFinite(item.updatedAt)
      && Array.isArray(item.messages)
      && item.messages.every((message: unknown) => Boolean(message && typeof message === 'object'
        && ['user', 'assistant'].includes((message as AiChatMessage).role)
        && typeof (message as AiChatMessage).content === 'string'))));
  } catch (error) {
    console.error('Could not load saved AI conversations:', error);
    return [];
  }
}

function conversationTitle(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim();
  return title.length > 58 ? `${title.slice(0, 55)}…` : title || 'New conversation';
}

function makeConversationPrompt(messages: AiChatMessage[], latestPrompt: string): string {
  const prior = messages.slice(0, -1);
  const lines: string[] = [];
  let length = 0;
  for (let index = prior.length - 1; index >= 0 && lines.length < 16; index--) {
    const message = prior[index];
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(-3500)}`;
    if (length + line.length > 14_000) break;
    lines.unshift(line);
    length += line.length;
  }
  return `${lines.length ? `Earlier conversation (continue naturally and use this context):\n${lines.join('\n\n')}\n\n` : ''}Latest user message:\n${latestPrompt}`;
}

export function createPineAiAssistant(options: PineAiAssistantOptions): PineAiAssistant {
  const panel = document.getElementById('pine-ai-assistant') as HTMLElement;
  const toggle = document.getElementById('btn-ai-assistant') as HTMLButtonElement;
  const provider = document.getElementById('pine-ai-provider') as HTMLSelectElement;
  const model = document.getElementById('pine-ai-model') as HTMLSelectElement;
  const key = document.getElementById('pine-ai-key') as HTMLInputElement;
  const cloudSettings = document.getElementById('pine-ai-cloud-settings') as HTMLDivElement;
  const localSettings = document.getElementById('pine-ai-local-settings') as HTMLDivElement;
  const localUrl = document.getElementById('pine-ai-local-url') as HTMLInputElement;
  const localKey = document.getElementById('pine-ai-local-key') as HTMLInputElement;
  const localModel = document.getElementById('pine-ai-local-model') as HTMLInputElement;
  const localModels = document.getElementById('pine-ai-local-models') as HTMLDataListElement;
  const testLocal = document.getElementById('pine-ai-test-local') as HTMLButtonElement;
  const saveLocal = document.getElementById('pine-ai-save-local') as HTMLButtonElement;
  const clearLocalKey = document.getElementById('pine-ai-clear-local-key') as HTMLButtonElement;
  const prompt = document.getElementById('pine-ai-prompt') as HTMLTextAreaElement;
  const status = document.getElementById('pine-ai-status') as HTMLParagraphElement;
  const luxAlgoEnabled = document.getElementById('pine-ai-luxalgo-enabled') as HTMLInputElement;
  const chat = document.getElementById('pine-ai-chat') as HTMLDivElement;
  const history = document.getElementById('pine-ai-history') as HTMLDivElement;
  const conversationTitleElement = document.getElementById('pine-ai-conversation-title') as HTMLParagraphElement;
  const modelStatus = document.getElementById('pine-ai-model-status') as HTMLSpanElement;
  const historyToggle = document.getElementById('pine-ai-history-toggle') as HTMLButtonElement;
  const settings = document.getElementById('pine-ai-settings') as HTMLDetailsElement;
  const saveKey = document.getElementById('pine-ai-save-key') as HTMLButtonElement;
  const testKey = document.getElementById('pine-ai-test-key') as HTMLButtonElement;
  const clearKey = document.getElementById('pine-ai-clear-key') as HTMLButtonElement;
  const ask = document.getElementById('pine-ai-ask') as HTMLButtonElement;
  const close = document.getElementById('pine-ai-close') as HTMLButtonElement;
  const newButton = document.getElementById('pine-ai-new') as HTMLButtonElement;
  const resize = document.getElementById('pine-ai-resize') as HTMLElement;
  const reference = document.getElementById('pine-reference') as HTMLElement;
  const referenceToggle = document.getElementById('btn-pine-reference') as HTMLButtonElement;
  const referenceResize = document.getElementById('pine-reference-resize') as HTMLElement;
  const aiModels = new Map<PineAiProviderStatus['id'], PineAiModel[]>();
  const configuredProviders = new Map<PineAiProviderStatus['id'], boolean>();
  let conversations = loadConversations();
  let activeConversationId = conversations[0]?.id ?? '';
  luxAlgoEnabled.checked = localStorage.getItem('omega_ai_luxalgo_mcp') === 'true';

  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    if (isError) status.dataset.state = 'error';
    else delete status.dataset.state;
  };

  const saveConversations = () => {
    try {
      localStorage.setItem(historyStorageKey, JSON.stringify(conversations));
    } catch (error) {
      setStatus(`Could not save AI conversation history: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const activeConversation = (): AiConversation => {
    let conversation = conversations.find(item => item.id === activeConversationId);
    if (!conversation) {
      conversation = { id: newConversationId(), title: 'New conversation', updatedAt: Date.now(), messages: [] };
      conversations.unshift(conversation);
      activeConversationId = conversation.id;
      saveConversations();
    }
    return conversation;
  };

  const renderHistory = () => {
    history.replaceChildren();
    if (!conversations.length) {
      history.textContent = 'No saved conversations yet.';
      return;
    }
    for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const row = document.createElement('div');
      row.className = 'pine-ai-history-item';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn pine-ai-history-open';
      open.textContent = conversation.title;
      open.title = `${conversation.title} · ${new Date(conversation.updatedAt).toLocaleString()}`;
      open.addEventListener('click', () => {
        activeConversationId = conversation.id;
        renderConversation();
        history.hidden = true;
        historyToggle.setAttribute('aria-expanded', 'false');
        prompt.focus();
      });
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'btn';
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => {
        void (async () => {
          const name = await promptForText({
            title: 'Rename conversation',
            label: 'Conversation name',
            value: conversation.title,
            confirmLabel: 'Rename',
            validate: value => (value ? null : 'Enter a conversation name.'),
          });
          if (!name) return;
          conversation.title = name.slice(0, 100);
          conversation.updatedAt = Date.now();
          saveConversations();
          renderConversation();
        })();
      });
      row.append(open, rename);
      history.append(row);
    }
  };

  const appendText = (host: HTMLElement, text: string) => {
    const node = document.createElement('div');
    node.className = 'pine-ai-message-text';
    node.textContent = text;
    host.append(node);
  };

  const renderMessage = (message: AiChatMessage) => {
    const article = document.createElement('article');
    article.className = 'pine-ai-message';
    article.dataset.role = message.role;
    const label = document.createElement('p');
    label.className = 'pine-ai-message-label';
    label.textContent = message.role === 'user' ? 'You' : 'Omega AI';
    article.append(label);

    // Add copy button for user messages
    if (message.role === 'user') {
      const copyMessageBtn = document.createElement('button');
      copyMessageBtn.type = 'button';
      copyMessageBtn.className = 'btn pine-ai-copy-message';
      copyMessageBtn.textContent = '📋 Copy';
      copyMessageBtn.style.cssText = 'font-size: 11px; padding: 2px 6px; margin-top: 4px;';
      copyMessageBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(message.content);
          } else {
            const temporary = document.createElement('textarea');
            temporary.value = message.content;
            temporary.style.position = 'fixed';
            temporary.style.opacity = '0';
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand('copy');
            temporary.remove();
            if (!copied) throw new Error('Clipboard access is unavailable.');
          }
          copyMessageBtn.textContent = '✓ Copied';
          window.setTimeout(() => { copyMessageBtn.textContent = '📋 Copy'; }, 1600);
        } catch (error) {
          setStatus(`Could not copy message: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      });
      article.append(copyMessageBtn);
    }

    let cursor = 0;
    for (const match of message.content.matchAll(codeBlockPattern)) {
      const start = match.index ?? 0;
      if (start > cursor) appendText(article, message.content.slice(cursor, start));
      const code = match[2].replace(/\r?\n$/, '');
      const block = document.createElement('section');
      block.className = 'pine-ai-code';
      const header = document.createElement('div');
      header.className = 'pine-ai-code-header';
      const language = document.createElement('span');
      language.textContent = match[1] || 'code';
      header.append(language);
      const pre = document.createElement('pre');
      const codeNode = document.createElement('code');
      codeNode.textContent = code;
      pre.append(codeNode);
      const actions = document.createElement('div');
      actions.className = 'pine-ai-code-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn';
      copy.textContent = 'Copy code';
      copy.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(code);
          } else {
            const temporary = document.createElement('textarea');
            temporary.value = code;
            temporary.style.position = 'fixed';
            temporary.style.opacity = '0';
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand('copy');
            temporary.remove();
            if (!copied) throw new Error('Clipboard access is unavailable.');
          }
          copy.textContent = 'Copied';
          window.setTimeout(() => { copy.textContent = 'Copy code'; }, 1600);
        } catch (error) {
          setStatus(`Could not copy code: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      });
      actions.append(copy);
      block.append(header, pre, actions);
      article.append(block);
      cursor = start + match[0].length;
    }
    if (cursor < message.content.length) appendText(article, message.content.slice(cursor));
    chat.append(article);
  };

  const renderConversation = () => {
    const conversation = activeConversation();
    conversationTitleElement.textContent = conversation.title;
    chat.replaceChildren();
    if (conversation.messages.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'pine-ai-empty-state';
      const title = document.createElement('strong');
      title.textContent = 'How can I help?';
      const description = document.createElement('p');
      description.textContent = 'Ask a question about Pine Script or the script open in the editor. Your conversation and code will appear here.';
      emptyState.append(title, description);
      chat.append(emptyState);
    }
    conversation.messages.forEach(renderMessage);
    chat.scrollTop = chat.scrollHeight;
    renderHistory();
  };

  const selectedProvider = (): PineAiProviderStatus['id'] => provider.value as PineAiProviderStatus['id'];

  const renderModelStatus = (keyState?: string) => {
    const providerName = provider.selectedOptions[0]?.textContent?.trim() || provider.value;
    const selectedModel = selectedProvider() === 'local'
      ? aiModels.get('local')?.find(item => item.id === localModel.value)
      : aiModels.get(selectedProvider())?.find(item => item.id === model.value);
    const modelId = selectedProvider() === 'local' ? localModel.value : model.value;
    const modelName = selectedModel && selectedModel.name !== selectedModel.id
      ? `${selectedModel.name} (${selectedModel.id})`
      : modelId || 'No model selected';
    const configured = configuredProviders.get(selectedProvider());
    const keyLabel = keyState ?? (configured === undefined
      ? 'key status unknown'
      : configured ? 'key saved' : 'key not saved');
    modelStatus.textContent = `${providerName} · ${modelName} · ${keyLabel}`;
    modelStatus.title = modelStatus.textContent;
    modelStatus.dataset.state = configured === true ? 'ready' : configured === false ? 'setup' : 'unknown';
  };

  const syncModel = () => {
    const selected = selectedProvider();
    const saved = localStorage.getItem(`omega_ai_model_${selected}`) || defaultModels[selected];
    const models = aiModels.get(selected);
    model.replaceChildren();
    if (!models?.length) {
      const option = document.createElement('option');
      option.value = saved;
      option.textContent = `${saved} (test API key to load models)`;
      model.append(option);
      renderModelStatus();
      return;
    }
    for (const item of models) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name === item.id ? item.id : `${item.name} · ${item.id}`;
      model.append(option);
    }
    model.value = models.some(item => item.id === saved) ? saved
      : models.some(item => item.id === defaultModels[selected]) ? defaultModels[selected]
        : models[0].id;
    renderModelStatus();
  };

  const refreshProviderStatus = async () => {
    if (!window.velaAi) {
      renderModelStatus('desktop app required');
      setStatus('This is the browser preview. Use the Omega desktop app to enable AI requests with encrypted API-key storage.', true);
      return;
    }
    try {
      const providers = await window.velaAi.providers();
      for (const item of providers) configuredProviders.set(item.id, item.configured);
      if (selectedProvider() === 'local') {
        const config = await window.velaAi.localConfig();
        localUrl.value = config.baseUrl;
        localKey.value = '';
        localModel.value = config.model;
        localSettings.hidden = false;
        cloudSettings.hidden = true;
        model.hidden = true;
        renderModelStatus(configuredProviders.get('local')
          ? (config.hasApiKey ? 'local endpoint · API key encrypted' : 'local endpoint · no key required')
          : 'local endpoint not saved');
        setStatus(configuredProviders.get('local')
          ? `Local endpoint saved at ${config.baseUrl}. Prompts stay on this computer unless LuxAlgo MCP research is enabled.`
          : 'Enter a localhost endpoint, test it, then save the model settings.');
        return;
      }
      localSettings.hidden = true;
      cloudSettings.hidden = false;
      model.hidden = false;
      const selected = providers.find(item => item.id === selectedProvider());
      renderModelStatus();
      setStatus(selected?.configured
        ? `${selected.name} key is saved using operating-system encryption.`
        : `No ${selected?.name ?? 'provider'} key saved. Enter an API key to continue.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  };

  const updateProviderStatus = (providers: PineAiProviderStatus[]) => {
    for (const item of providers) configuredProviders.set(item.id, item.configured);
    const selected = providers.find(item => item.id === selectedProvider());
    renderModelStatus();
    setStatus(selected?.configured
      ? `${selected.name} key is saved using operating-system encryption.`
      : `No ${selected?.name ?? 'provider'} key saved.`);
  };

  const setupResizer = (handle: HTMLElement, target: HTMLElement, storageKey: string, minimum: number, ratio: number) => {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved >= minimum) target.style.width = `${saved}px`;
    let resizing = false;
    handle.addEventListener('pointerdown', event => {
      resizing = true;
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);
      document.body.style.userSelect = 'none';
    });
    handle.addEventListener('pointermove', event => {
      if (!resizing) return;
      const bounds = handle.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.max(minimum, Math.min(bounds.width * ratio, bounds.right - event.clientX));
      target.style.width = `${width}px`;
      localStorage.setItem(storageKey, String(Math.round(width)));
    });
    const stop = () => {
      resizing = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const bounds = handle.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      const direction = target.id === 'pine-ai-assistant' ? -1 : 1;
      const change = (event.key === 'ArrowLeft' ? 1 : -1) * 24 * direction;
      const width = Math.max(minimum, Math.min(bounds.width * ratio, target.clientWidth + change));
      target.style.width = `${width}px`;
      localStorage.setItem(storageKey, String(Math.round(width)));
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  };

  const submitPrompt = async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot make AI requests. Use the Omega desktop app, where API keys stay encrypted.', true);
    const text = prompt.value.trim();
    if (!text) return setStatus('Describe what you want the assistant to do.');
    ask.disabled = true;
    setStatus(luxAlgoEnabled.checked
      ? 'Searching the public LuxAlgo Library, then sending the prompt and Pine script to your selected AI provider…'
      : selectedProvider() === 'local'
        ? 'Sending the prompt and current Pine script to your localhost model…'
        : 'Sending the prompt and current Pine script to your selected AI provider…');
    const conversation = activeConversation();
    const conversationId = conversation.id;
    conversation.messages.push({ role: 'user', content: text });
    if (conversation.messages.filter(message => message.role === 'user').length === 1) conversation.title = conversationTitle(text);
    conversation.updatedAt = Date.now();
    prompt.value = '';
    saveConversations();
    renderConversation();
    try {
      const result = await window.velaAi.complete({
        provider: selectedProvider(),
        model: selectedProvider() === 'local' ? localModel.value.trim() : model.value.trim(),
        prompt: makeConversationPrompt(conversation.messages, text),
        source: options.getEditorValue(),
        scriptName: options.getCurrentScriptName(),
        useLuxAlgoMcp: luxAlgoEnabled.checked,
      });
      conversation.messages.push({ role: 'assistant', content: result.text });
      conversation.updatedAt = Date.now();
      saveConversations();
      if (activeConversationId === conversationId) {
        renderConversation();
        setStatus(`Response from ${result.model}. Copy any code you want into the Pine editor.`);
      }
      localStorage.setItem(`omega_ai_model_${selectedProvider()}`, selectedProvider() === 'local' ? localModel.value.trim() : model.value.trim());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      ask.disabled = false;
    }
  };

  document.getElementById('pine-reference-close')!.addEventListener('click', () => {
    reference.hidden = true;
    referenceResize.hidden = true;
    referenceToggle.setAttribute('aria-expanded', 'false');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
  referenceToggle.addEventListener('click', () => {
    const opening = reference.hidden;
    if (opening && !panel.hidden) {
      panel.hidden = true;
      resize.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
    reference.hidden = !opening;
    referenceResize.hidden = !opening;
    referenceToggle.setAttribute('aria-expanded', String(opening));
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
  window.addEventListener('pine-reference:open', () => {
    if (!panel.hidden) {
      panel.hidden = true;
      resize.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
    reference.hidden = false;
    referenceResize.hidden = false;
    referenceToggle.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    resize.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) {
      if (!reference.hidden) {
        reference.hidden = true;
        referenceResize.hidden = true;
        referenceToggle.setAttribute('aria-expanded', 'false');
      }
      syncModel();
      renderConversation();
      void refreshProviderStatus();
      settings.open = false;
    } else {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    resize.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
  provider.addEventListener('change', () => {
    key.value = '';
    syncModel();
    renderModelStatus(selectedProvider() === 'local' ? 'loading local endpoint…' : 'checking key…');
    void refreshProviderStatus();
  });

  // Add active state styling for Provider settings button
  settings.addEventListener('toggle', () => {
    if (settings.open) {
      settings.querySelector('summary')?.classList.add('active');
    } else {
      settings.querySelector('summary')?.classList.remove('active');
    }
  });
  model.addEventListener('change', () => {
    localStorage.setItem(`omega_ai_model_${selectedProvider()}`, model.value.trim());
    renderModelStatus();
  });
  localModel.addEventListener('input', () => renderModelStatus());
  testLocal.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('Local AI endpoint testing is available in the Omega desktop app.', true);
    testLocal.disabled = true;
    try {
      const result = await window.velaAi.testLocalConfig({ baseUrl: localUrl.value.trim(), apiKey: localKey.value });
      aiModels.set('local', result.models);
      localModels.replaceChildren(...result.models.map(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.label = item.name;
        return option;
      }));
      if (!localModel.value.trim() || !result.models.some(item => item.id === localModel.value)) {
        localModel.value = result.defaultModel;
      }
      renderModelStatus('endpoint reachable');
      setStatus(`Connected to localhost. Loaded ${result.models.length} models; choose one and save the settings.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      testLocal.disabled = false;
    }
  });
  saveLocal.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('Local AI settings are available in the Omega desktop app.', true);
    saveLocal.disabled = true;
    try {
      const result = await window.velaAi.saveLocalConfig({
        baseUrl: localUrl.value.trim(),
        model: localModel.value.trim(),
        apiKey: localKey.value,
      });
      localUrl.value = result.baseUrl;
      localModel.value = result.model;
      localKey.value = '';
      configuredProviders.set('local', true);
      renderModelStatus(result.hasApiKey ? 'local API key encrypted' : 'no API key required');
      setStatus(`Saved localhost model ${result.model} at ${result.baseUrl}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      saveLocal.disabled = false;
    }
  });
  clearLocalKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('Local AI settings are available in the Omega desktop app.', true);
    clearLocalKey.disabled = true;
    try {
      const result = await window.velaAi.saveLocalConfig({
        baseUrl: localUrl.value.trim(),
        model: localModel.value.trim(),
        clearApiKey: true,
      });
      configuredProviders.set('local', true);
      localKey.value = '';
      renderModelStatus('no API key required');
      setStatus(`Removed the saved local API key. The endpoint at ${result.baseUrl} remains configured.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearLocalKey.disabled = false;
    }
  });
  saveKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot access encrypted key storage. Use the Omega desktop app to save an API key.', true);
    const value = key.value;
    if (!value.trim()) return setStatus('Enter an API key before saving.', true);
    saveKey.disabled = true;
    setStatus('Encrypting and saving the API key…');
    try {
      updateProviderStatus(await window.velaAi.saveKey(selectedProvider(), value));
      key.value = '';
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      saveKey.disabled = false;
    }
  });
  testKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot test keys. Use the Omega desktop app.', true);
    testKey.disabled = true;
    saveKey.disabled = true;
    clearKey.disabled = true;
    setStatus(`Checking ${provider.selectedOptions[0]?.textContent ?? 'provider'} API key and loading available models…`);
    try {
      const result = await window.velaAi.testKey(selectedProvider(), key.value.trim() || undefined);
      aiModels.set(result.provider, result.models);
      key.value = '';
      updateProviderStatus(result.providers);
      syncModel();
      setStatus(`API key is valid. Loaded ${result.models.length} models from ${provider.selectedOptions[0]?.textContent ?? 'provider'}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      testKey.disabled = false;
      saveKey.disabled = false;
      clearKey.disabled = false;
    }
  });
  clearKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot access encrypted key storage. Use the Omega desktop app to remove an API key.', true);
    if (!window.confirm(`Remove the saved ${provider.selectedOptions[0]?.textContent ?? 'provider'} API key from this computer?`)) return;
    clearKey.disabled = true;
    try {
      updateProviderStatus(await window.velaAi.clearKey(selectedProvider()));
      key.value = '';
      aiModels.delete(selectedProvider());
      syncModel();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearKey.disabled = false;
    }
  });
  ask.addEventListener('click', () => void submitPrompt());
  luxAlgoEnabled.addEventListener('change', () => {
    localStorage.setItem('omega_ai_luxalgo_mcp', String(luxAlgoEnabled.checked));
    setStatus(luxAlgoEnabled.checked
      ? 'LuxAlgo Library MCP research is enabled for the next prompt.'
      : 'LuxAlgo Library MCP research is disabled.');
  });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
    }
  });
  newButton.addEventListener('click', () => {
    const conversation: AiConversation = { id: newConversationId(), title: 'New conversation', updatedAt: Date.now(), messages: [] };
    conversations.unshift(conversation);
    activeConversationId = conversation.id;
    saveConversations();
    renderConversation();
    history.hidden = true;
    historyToggle.setAttribute('aria-expanded', 'false');
    prompt.focus();
    setStatus('Started a new conversation. Previous chats remain saved in History.');
  });
  historyToggle.addEventListener('click', () => {
    history.hidden = !history.hidden;
    historyToggle.setAttribute('aria-expanded', String(!history.hidden));
    if (!history.hidden) renderHistory();
  });
  setupResizer(resize, panel, 'omega_pine_ai_width', 360, 0.7);
  if (options.manageReferenceResize !== false) {
    setupResizer(referenceResize, reference, 'vela_pine_reference_width', 250, 0.6);
  }

  syncModel();
  renderConversation();
  return {
    setStatus,
  };
}
