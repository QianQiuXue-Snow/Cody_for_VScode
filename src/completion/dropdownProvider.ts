import * as vscode from 'vscode';
import { openAIClient } from '../api/openaiClient';
import { Settings } from '../config/settings';

/**
 * 下拉补全 Provider（本地毫秒出 + 后台 AI 无缝替换）
 *
 * 流程：
 * 1. 本地前缀匹配 → 立即返回（<1ms）
 * 2. 后台启动 AI 请求（SSE 流式，不阻塞）
 * 3. AI 生成完毕 → 缓存结果 → 自动触发 editor.action.triggerSuggest
 * 4. VSCode 重新调用 provideCompletionItems → 看到缓存 → 返回 AI 结果首位
 */
export class DropdownCompletionProvider implements vscode.CompletionItemProvider {
  /** AI 结果缓存：prefix → CompletionItem[] */
  private aiCache = new Map<string, vscode.CompletionItem[]>();
  /** 当前正在等待的 AI prefix */
  private pendingAiPrefix: string | null = null;
  /** 防重复触发的 generation 标记 */
  private aiGeneration = 0;
  /** 最后一次返回 AI 的 prefix（避免无限循环 re-trigger） */
  private lastAiPrefix: string | null = null;

  // ========== VSCode 接口 ==========

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

    // ===== 1. 本地补全（始终返回，<1ms） =====
    const localItems = this.getLocalMatches(document, position, prefix);

    // ===== 2. 检查 AI 缓存 =====
    const aiItems = this.aiCache.get(prefix);
    if (aiItems) {
      // 有缓存 → AI 结果放首位
      const result = [...aiItems];
      if (localItems.length > 0) {
        // 分隔符
        const sep = new vscode.CompletionItem('- 本地匹配 -', vscode.CompletionItemKind.Text);
        sep.sortText = '~local';
        sep.preselect = false;
        result.push(sep);
        result.push(...localItems);
      }
      return result;
    }

    // ===== 3. 无缓存 → 启动后台 AI =====
    this.startBackgroundAi(document, position, prefix);

    // 添加加载指示器
    if (localItems.length > 0) {
      const loading = new vscode.CompletionItem('⏳ AI 生成中...', vscode.CompletionItemKind.Event);
      loading.sortText = '!ai-loading';
      loading.preselect = false;
      loading.detail = '后台 AI 正在流式生成补全';
      return [loading, ...localItems];
    }

    const loading = new vscode.CompletionItem('⏳ AI 生成中...', vscode.CompletionItemKind.Event);
    loading.detail = '后台 AI 正在流式生成补全';
    loading.preselect = false;
    return [loading];
  }

  resolveCompletionItem(
    item: vscode.CompletionItem,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem> {
    return item;
  }

  // ========== 本地前缀匹配 ==========

  /** 提取光标前缀（word-like） */
  private getPrefix(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line);
    const text = line.text.substring(0, position.character);
    const m = text.match(/(\w[\w.]*)$/);
    return m ? m[1] : '';
  }

  /** 从当前文件提取匹配前缀的单词  */
  private getLocalMatches(
    document: vscode.TextDocument,
    position: vscode.Position,
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
      item.sortText = `0${String(items.length).padStart(4, '0')}`; // 按出现顺序
      item.filterText = word;
      item.detail = '本地';
      items.push(item);
      if (items.length >= 10) break;
    }
    return items;
  }

  // ========== 后台 AI ==========

  private startBackgroundAi(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string
  ): void {
    // 防重复：相同 prefix 不重复请求
    if (this.pendingAiPrefix === prefix) return;
    this.pendingAiPrefix = prefix;
    const gen = ++this.aiGeneration;

    const language = document.languageId || 'plaintext';
    const startOffset = Math.max(0, document.offsetAt(position) - 400);
    const startPos = document.positionAt(startOffset);
    const codeBefore = document.getText(new vscode.Range(startPos, position));

    const endOffset = Math.min(document.getText().length, document.offsetAt(position) + 80);
    const endPos = document.positionAt(endOffset);
    const codeAfter = document.getText(new vscode.Range(position, endPos));

    // 异步执行，不阻塞
    (async () => {
      try {
        const completion = await openAIClient.getCompletion(codeBefore, codeAfter, language);
        if (!completion || completion.trim().length === 0) return;

        // 清理
        let text = completion.trim()
          .replace(/^```[\w]*\n?/g, '')
          .replace(/\n?```$/g, '');

        // 去重光标前行尾
        const lastLine = (codeBefore.split('\n').pop() || '').trimEnd();
        if (lastLine && text.startsWith(lastLine)) {
          text = text.slice(lastLine.length);
        }
        text = text.trim();
        if (!text || text.length <= 1) return;

        // 按 prefix 补全：如果模型输出以 prefix 开头，去掉
        if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
          text = text.slice(prefix.length);
        }
        if (!text) return;

        const label = text.length > 60 ? text.substring(0, 60).replace(/\n/g, '↵') + '…' : text.replace(/\n/g, '↵');

        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(text);
        item.sortText = '!ai'; // 排在最前面
        item.filterText = text;
        item.detail = '🤖 AI 补全';
        item.documentation = new vscode.MarkdownString(
          `\`\`\`${language}\n${prefix}${text}\n\`\`\``
        );

        // 缓存
        this.aiCache.set(prefix, [item]);
        // 限制缓存数量
        if (this.aiCache.size > 30) {
          const first = this.aiCache.keys().next().value;
          if (first) this.aiCache.delete(first);
        }

        // 检查是否过期（用户已输入其他内容）
        if (gen !== this.aiGeneration) return;
        this.pendingAiPrefix = null;

        // 避免循环：如果上次就是用这个 prefix 触发的，跳过
        if (this.lastAiPrefix === prefix) return;
        this.lastAiPrefix = prefix;

        // 检查光标是否还在原地
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document) return;
        const currentPrefix = this.getPrefix(editor.document, editor.selection.active);
        if (currentPrefix !== prefix) return;

        // 自动重新触发下拉
        await vscode.commands.executeCommand('editor.action.triggerSuggest');

        // 清除 AI prefix 标记（允许下次再触发）
        setTimeout(() => { this.lastAiPrefix = null; }, 2000);

      } catch (error: any) {
        if (error?.name === 'CompletionTimeout' || error?.message?.includes('超时')) {
          // 超时静默
        }
        this.pendingAiPrefix = null;
      }
    })();
  }

  /** 清除缓存（配置变更时调用） */
  clearCache(): void {
    this.aiCache.clear();
    this.pendingAiPrefix = null;
    this.aiGeneration++;
  }
}
