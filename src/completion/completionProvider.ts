import * as vscode from 'vscode';
import { openAIClient } from '../api/openaiClient';
import { Settings } from '../config/settings';

// 兼容 VSCode <1.68：Inline* 类不存在时用 any 回退
const _v = vscode as any;
const InlineCompletionItem: any = _v.InlineCompletionItem ?? (function dummy() {});
const InlineCompletionTriggerKindAutomatic = _v.InlineCompletionTriggerKind?.Automatic ?? 0;

// ========== 补全缓存 LRU ==========
interface CacheEntry { completion: string; timestamp: number; }
class CompletionCache {
  private map = new Map<string, CacheEntry>();
  private readonly maxSize = 64;
  private readonly ttlMs = 60_000;

  private makeKey(language: string, codeBefore: string): string {
    const tail = codeBefore.length > 80 ? codeBefore.slice(-80) : codeBefore;
    return `${language}::${tail.replace(/\s+/g, ' ').trim()}`;
  }

  get(language: string, codeBefore: string): string | null {
    const entry = this.map.get(this.makeKey(language, codeBefore));
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(this.makeKey(language, codeBefore));
      return null;
    }
    this.map.delete(this.makeKey(language, codeBefore));
    this.map.set(this.makeKey(language, codeBefore), entry);
    return entry.completion;
  }

  set(language: string, codeBefore: string, completion: string): void {
    if (completion.length < 2) return;
    const key = this.makeKey(language, codeBefore);
    if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
    this.map.set(key, { completion, timestamp: Date.now() });
  }

  clear(): void { this.map.clear(); }
}

const cache = new CompletionCache();

// ========== Provider ==========

/**
 * 实时代码补全 Provider
 *
 * 仅在 VSCode ≥1.68 时注册为 InlineCompletionItemProvider。
 */
export class CompletionProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private isEnabled: boolean = true;
  private pendingRequest: { cancel: () => void } | null = null;

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiAssistant')) {
        openAIClient.refreshConfig();
        this.isEnabled = Settings.enableCompletion;
      }
    });
  }

  get name(): string { return 'Cody'; }
  setEnabled(enabled: boolean): void { this.isEnabled = enabled; }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: any, // vscode.InlineCompletionContext (≥1.68)
    token: vscode.CancellationToken
  ): Promise<any[]> {
    if (!this.isEnabled || !Settings.isInlineMode) return [];

    const triggerKind = context?.triggerKind;
    if (triggerKind === InlineCompletionTriggerKindAutomatic) {
      return this.debouncedCompletion(document, position, token);
    }
    return this.doCompletion(document, position, token);
  }

  private debouncedCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<any[]> {
    if (this.pendingRequest) { this.pendingRequest.cancel(); this.pendingRequest = null; }

    return new Promise((resolve) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);

      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) { resolve([]); return; }

        let resolved = false;
        this.pendingRequest = {
          cancel: () => {
            if (!resolved) { resolved = true; resolve([]); }
          }
        };

        const items = await this.doCompletion(document, position, token);
        if (!resolved) { resolved = true; resolve(items); }
        this.pendingRequest = null;
      }, 250);

      token.onCancellationRequested(() => {
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
        if (this.pendingRequest) { this.pendingRequest.cancel(); this.pendingRequest = null; }
        resolve([]);
      });
    });
  }

  private async doCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<any[]> {
    try {
      const language = document.languageId || 'plaintext';

      const startOffset = Math.max(0, document.offsetAt(position) - 400);
      const startPos = document.positionAt(startOffset);
      const codeBefore = document.getText(new vscode.Range(startPos, position));

      const endOffset = Math.min(document.getText().length, document.offsetAt(position) + 80);
      const endPos = document.positionAt(endOffset);
      const codeAfter = document.getText(new vscode.Range(position, endPos));

      if (token.isCancellationRequested) return [];

      const cached = cache.get(language, codeBefore);
      if (cached) {
        console.log('[Cody] 缓存命中');
        return this.makeItems(cached, position);
      }

      console.log('[Cody] 补全请求:', { language, beforeLen: codeBefore.length });

      const completion = await this.withTimeout(
        openAIClient.getCompletion(codeBefore, codeAfter, language),
        8000
      );

      if (token.isCancellationRequested) return [];
      if (!completion || completion.trim().length === 0) return [];

      const cleaned = this.cleanAndFilter(completion, codeBefore, codeAfter);
      if (!cleaned) return [];

      console.log('[Cody] 补全成功:', { rawLen: completion.length, cleanedLen: cleaned.length });

      cache.set(language, codeBefore, cleaned);

      return this.makeItems(cleaned, position);

    } catch (error: any) {
      if (error?.name === 'CompletionTimeout' || error?.message?.includes('超时')) {
        return [];
      }
      console.error('[Cody] 补全失败:', error);
      return [];
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`补全超时（${ms / 1000}秒）`), { name: 'CompletionTimeout' }));
      }, ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  private cleanAndFilter(
    completion: string,
    codeBefore: string,
    codeAfter: string
  ): string | null {
    let text = completion.trim();

    text = text.replace(/^```[\w]*\n?/g, '').replace(/\n?```$/g, '');

    text = this.stripExistingLines(text, codeBefore);

    const lastLineOfBefore = codeBefore.split('\n').pop() || '';
    const trimmedLastLine = lastLineOfBefore.trimEnd();
    if (trimmedLastLine && text.startsWith(trimmedLastLine)) {
      text = text.slice(trimmedLastLine.length);
    }

    text = this.stripLongestSuffix(text, codeBefore);

    const firstLineOfAfter = codeAfter.trimStart().split('\n')[0] || '';
    if (firstLineOfAfter.length > 0 && text.includes(firstLineOfAfter)) {
      const idx = text.indexOf(firstLineOfAfter);
      if (idx > 0) text = text.substring(0, idx).trimEnd();
    }

    text = text.trim();
    if (text.length === 0) return null;

    if (/^[\s\t\n\r]+$/.test(text)) return null;
    if (text.length <= 1 && !text.match(/[\)\]\}\"']/)) return null;
    text = this.truncateToCompleteBlock(text);

    return text || null;
  }

  private stripExistingLines(completion: string, codeBefore: string): string {
    const compLines = completion.split('\n');
    const beforeLines = codeBefore.split('\n');
    const tail = beforeLines.slice(-5);

    let stripCount = 0;
    for (let i = 0; i < Math.min(compLines.length, 5); i++) {
      const compLine = compLines[i].trim();
      if (compLine.length === 0) break;
      const found = tail.some(bl => bl.trim() === compLine);
      if (found) stripCount = i + 1;
      else break;
    }
    return stripCount > 0 ? compLines.slice(stripCount).join('\n') : completion;
  }

  private stripLongestSuffix(completion: string, codeBefore: string): string {
    const suffix = codeBefore.length > 200 ? codeBefore.slice(-200) : codeBefore;
    const prefix = completion.length > 200 ? completion.slice(0, 200) : completion;

    let maxOverlap = 0;
    for (let i = Math.min(prefix.length, suffix.length); i > 0; i--) {
      const prefixPart = prefix.substring(0, i);
      if (suffix.endsWith(prefixPart)) {
        maxOverlap = i;
        break;
      }
    }
    return maxOverlap > 0 ? completion.substring(maxOverlap) : completion;
  }

  private truncateToCompleteBlock(text: string): string {
    const lines = text.split('\n');

    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    if (lines.length === 0) return '';

    const last = lines[lines.length - 1].trimEnd();
    if (this.isCompleteLineEnding(last)) return lines.join('\n');

    for (let i = lines.length - 2; i >= 0; i--) {
      const candidate = lines[i].trimEnd();
      if (this.isCompleteLineEnding(candidate)) {
        return lines.slice(0, i + 1).join('\n');
      }
    }

    return lines[0];
  }

  private isCompleteLineEnding(line: string): boolean {
    const t = line.trimEnd();
    if (t.length === 0) return true;
    if (/[;{})\]>'"`]$/.test(t)) return true;
    if (t.endsWith(':')) return true;
    if (/[+\-*/%=<>!&|^~,]$/.test(t)) return false;
    return true;
  }

  private makeItems(text: string, position: vscode.Position): any[] {
    const item = new (InlineCompletionItem)(text, new vscode.Range(position, position));
    const firstLine = text.split('\n')[0];
    item.filterText = firstLine;
    return [item];
  }
}
