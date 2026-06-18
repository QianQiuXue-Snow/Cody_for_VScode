import * as vscode from 'vscode';
import { openAIClient } from '../api/openaiClient';
import { Settings } from '../config/settings';
import { cleanCompletion } from './completionCleaner';

/**
 * 下拉补全 Provider（本地毫秒出 + 后台 AI 无缝替换）
 *
 * 请求管理：
 * - aiGeneration：每次新前缀触发时 +1，旧请求完成时比对过期则丢弃
 * - pendingAiPrefix：防止同一前缀重复请求
 * - lastAiPrefix：防止无限重新触发下拉循环
 */
export class DropdownCompletionProvider implements vscode.CompletionItemProvider {
  private aiCache = new Map<string, vscode.CompletionItem[]>();
  private pendingAiPrefix: string | null = null;
  private aiGeneration = 0;
  private lastAiPrefix: string | null = null;
  private lastAiPrefixTimer: ReturnType<typeof setTimeout> | undefined;

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
    if (!Settings.enableCompletion || !Settings.isDropdownMode) {
      return [];
    }

    const prefix = this.getPrefix(document, position);
    if (prefix.length < 2) return [];

    // 1. 本地补全（始终返回）
    const localItems = this.getLocalMatches(document, position, prefix);

    // 2. AI 缓存命中 → 直接返回
    const aiItems = this.aiCache.get(prefix);
    if (aiItems) {
      const result = [...aiItems];
      if (localItems.length > 0) {
        const sep = new vscode.CompletionItem('- 本地匹配 -', vscode.CompletionItemKind.Text);
        sep.sortText = '~local';
        sep.preselect = false;
        result.push(sep);
        result.push(...localItems);
      }
      return result;
    }

    // 3. 启动后台 AI
    this.startBackgroundAi(document, position, prefix);

    // 4. 返回本地结果 + 加载中提示
    if (localItems.length > 0) {
      const loading = new vscode.CompletionItem('⏳ AI 生成中...', vscode.CompletionItemKind.Event);
      loading.sortText = '!ai-loading';
      loading.preselect = false;
      loading.detail = '后台 AI 正在流式生成补全';
      return [loading, ...localItems];
    }
    const loading = new vscode.CompletionItem('⏳ AI 生成中...', vscode.CompletionItemKind.Event);
    loading.preselect = false;
    loading.detail = '后台 AI 正在流式生成补全';
    return [loading];
  }

  resolveCompletionItem(
    item: vscode.CompletionItem,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem> {
    return item;
  }

  // ===== 本地前缀匹配 =====

  private getPrefix(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line);
    const text = line.text.substring(0, position.character);
    const m = text.match(/(\w[\w.]*)$/);
    return m ? m[1] : '';
  }

  private getLocalMatches(
    document: vscode.TextDocument,
    _position: vscode.Position,
    prefix: string
  ): vscode.CompletionItem[] {
    const text = document.getText();
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    const lowerPrefix = prefix.toLowerCase();

    const re = /\b(\w[\w.]{1,40})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[1];
      if (word.length <= prefix.length) continue;
      if (!word.toLowerCase().startsWith(lowerPrefix)) continue;
      if (seen.has(word)) continue;
      seen.add(word);

      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
      item.sortText = `0${String(items.length).padStart(4, '0')}`;
      item.filterText = word;
      item.detail = '本地';
      items.push(item);
      if (items.length >= 10) break;
    }
    return items;
  }

  // ===== 后台 AI（清洗升级） =====

  private startBackgroundAi(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string
  ): void {
    // 同一前缀不重复请求
    if (this.pendingAiPrefix === prefix) return;

    // 新前缀 → 递增 generation，作废所有旧请求
    this.pendingAiPrefix = prefix;
    const gen = ++this.aiGeneration;

    const language = document.languageId || 'plaintext';

    // 上下文：光标前 800 字符，光标后 80 字符
    const beforeLen = Math.min(800, document.offsetAt(position));
    const startPos = document.positionAt(document.offsetAt(position) - beforeLen);
    const codeBefore = document.getText(new vscode.Range(startPos, position));

    const afterLen = Math.min(80, document.getText().length - document.offsetAt(position));
    const endPos = document.positionAt(document.offsetAt(position) + afterLen);
    const codeAfter = document.getText(new vscode.Range(position, endPos));

    (async () => {
      try {
        const completion = await openAIClient.getCompletion(codeBefore, codeAfter, language);

        // 过期检测
        if (gen !== this.aiGeneration) return;
        this.pendingAiPrefix = null;

        if (!completion || completion.trim().length === 0) return;

        const cleaned = cleanCompletion(completion, codeBefore, codeAfter, language);
        if (!cleaned) return;

        // 二次过期检测
        if (gen !== this.aiGeneration) return;

        // 去掉 prefix 前缀（若模型输出含 prefix）
        let final = cleaned;
        if (final.toLowerCase().startsWith(prefix.toLowerCase())) {
          final = final.slice(prefix.length);
        }
        final = final.trim();
        if (!final) return;

        const label = final.length > 60
          ? final.substring(0, 60).replace(/\n/g, '↵') + '…'
          : final.replace(/\n/g, '↵');

        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(final);
        item.sortText = '!ai';
        item.filterText = final;
        item.detail = '🤖 AI 补全';
        item.documentation = new vscode.MarkdownString(
          `\`\`\`${language}\n${prefix}${final}\n\`\`\``
        );

        // 缓存
        this.aiCache.set(prefix, [item]);
        if (this.aiCache.size > 30) {
          const first = this.aiCache.keys().next().value;
          if (first) this.aiCache.delete(first);
        }

        // 循环保护
        if (this.lastAiPrefix === prefix) return;
        this.lastAiPrefix = prefix;
        if (this.lastAiPrefixTimer) clearTimeout(this.lastAiPrefixTimer);
        this.lastAiPrefixTimer = setTimeout(() => { this.lastAiPrefix = null; }, 2000);

        // 光标位置校验
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document) return;
        const currentPrefix = this.getPrefix(editor.document, editor.selection.active);
        if (currentPrefix !== prefix) return;

        await vscode.commands.executeCommand('editor.action.triggerSuggest');

      } catch (error: any) {
        if (error?.name === 'CompletionTimeout' || error?.message?.includes('超时')) {
          // 超时静默
        }
        if (gen === this.aiGeneration) {
          this.pendingAiPrefix = null;
        }
      }
    })();
  }

  clearCache(): void {
    this.aiCache.clear();
    this.pendingAiPrefix = null;
    this.aiGeneration++;
    this.lastAiPrefix = null;
    if (this.lastAiPrefixTimer) {
      clearTimeout(this.lastAiPrefixTimer);
      this.lastAiPrefixTimer = undefined;
    }
  }
}
