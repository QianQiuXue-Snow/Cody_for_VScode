import * as vscode from 'vscode';
import { openAIClient } from '../api/openaiClient';
import { Settings } from '../config/settings';
import { cleanCompletion } from './completionCleaner';

// 兼容 VSCode <1.68
const _v = vscode as any;
const InlineCompletionItem: any = _v.InlineCompletionItem ?? (function dummy() {});
const InlineCompletionTriggerKindAutomatic = _v.InlineCompletionTriggerKind?.Automatic ?? 0;

/**
 * inline 幽灵文字补全 Provider
 *
 * 请求管理：
 * - generation：每次新补全触发时 +1，旧请求完成时比对，过期丢弃
 * - 防抖 200ms：快速连续打字时只发最后一次
 * - AbortController：API 层面取消（如实现支持）
 */
export class CompletionProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private isEnabled: boolean = true;
  private generation = 0; // 每次触发 +1，过期检测

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiAssistant')) {
        openAIClient.refreshConfig();
        this.isEnabled = Settings.enableCompletion;
      }
    });
  }

  get name(): string { return 'Cody'; }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled) this.reset();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: any,
    token: vscode.CancellationToken
  ): Promise<any[]> {
    if (!this.isEnabled || !Settings.isInlineMode) return [];

    const triggerKind = context?.triggerKind;
    if (triggerKind === InlineCompletionTriggerKindAutomatic) {
      return this.debouncedCompletion(document, position, token);
    }
    return this.doCompletion(document, position, token);
  }

  // ===== 防抖 + 丢弃未完成请求 =====

  private debouncedCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<any[]> {
    // 每次打字 → 清除旧定时器 + 递增 generation（使旧请求作废）
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    const gen = ++this.generation;

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) { resolve([]); return; }
        // 开始前再检查：期间是否有新触发？
        if (gen !== this.generation) { resolve([]); return; }

        const items = await this.doCompletion(document, position, token);
        // 完成后检查：期间是否有新触发？
        if (gen !== this.generation) { resolve([]); return; }

        resolve(items);
      }, 200);

      token.onCancellationRequested(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
        }
        resolve([]);
      });
    });
  }

  reset(): void {
    this.generation++;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  // ===== 补全主逻辑 =====

  private async doCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<any[]> {
    try {
      const language = document.languageId || 'plaintext';

      // 扩大上下文：取光标前 800 字符，光标后 80 字符
      const beforeLen = Math.min(800, document.offsetAt(position));
      const startPos = document.positionAt(document.offsetAt(position) - beforeLen);
      const codeBefore = document.getText(new vscode.Range(startPos, position));

      const afterLen = Math.min(80, document.getText().length - document.offsetAt(position));
      const endPos = document.positionAt(document.offsetAt(position) + afterLen);
      const codeAfter = document.getText(new vscode.Range(position, endPos));

      if (token.isCancellationRequested) return [];

      const completion = await this.withTimeout(
        openAIClient.getCompletion(codeBefore, codeAfter, language),
        8000
      );

      if (token.isCancellationRequested) return [];
      if (!completion || completion.trim().length === 0) return [];

      const cleaned = cleanCompletion(completion, codeBefore, codeAfter, language);
      if (!cleaned) return [];

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

  private makeItems(text: string, position: vscode.Position): any[] {
    const item = new (InlineCompletionItem)(text, new vscode.Range(position, position));
    const firstLine = text.split('\n')[0];
    item.filterText = firstLine;
    return [item];
  }
}
