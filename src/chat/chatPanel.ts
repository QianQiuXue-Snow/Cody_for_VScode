import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { openAIClient, ChatMessage } from '../api/openaiClient';
import { Settings } from '../config/settings';
import { getChatWebviewContent } from './webviewContent';
import {
  buildAgentSystemPrompt,
  parseToolCalls,
  executeTool,
  formatToolResultsForAI,
  formatToolResultsSummary,
  formatToolResultsDetails,
  isDangerous,
  ToolCall,
  ToolResult,
  SnapshotManager,
  TaskManager,
} from '../agent/agentEngine';
import { SkillManager } from '../skills/skillManager';

const MAX_HISTORY_ROUNDS = 15;
/** 超过此长度时写入临时文件 */
const TEMPFILE_THRESHOLD = 15000;

/** 推荐默认值（与 package.json 对齐） */
const DEFAULTS = {
  apiBaseUrl: 'http://localhost:8000/v1',
  apiKey: '',
  completionApiBaseUrl: '',
  completionApiKey: '',
  completionModel: 'MiniMax-M2.5-test',
  chatModel: 'MiniMax-M2.5-test',
  chatThinkingFormat: 'minimax',
  chatThinkingEnabled: true,
  completionThinkingFormat: 'minimax',
  completionMode: 'both',
  chatSystemPrompt: '你是 Cody，一个专业的编程助手，内嵌在 VSCode 编辑器中。请用中文回答问题，提供准确、有帮助的编程建议。回答时可以使用 Markdown 格式，代码块请标注语言。',
  maxAgentRounds: 10,
  agentMaxTokens: 8000,
  agentTemperature: 0.2,
};

type ChatMode = 'assistant' | 'agent';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiAssistant.chatView';

  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;
  private currentMode: ChatMode = 'assistant';
  private assistantHistory: ChatMessage[] = [];
  private agentHistory: ChatMessage[] = [];
  private abortController?: AbortController;
  private pendingToolCalls: ToolCall[] = [];
  private snapshotManager = new SnapshotManager();
  private taskManager = new TaskManager();
  private agentRunning = false;
  private agentPaused = false;
  private agentStopped = false;
  private pendingApprovalResolve: ((approved: boolean) => void) | null = null;
  /** 临时文件追踪 */
  private tempFiles: Set<string> = new Set();
  private tempDir: string = '';

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly skillManager: SkillManager
  ) {
    this._extensionUri = _context.extensionUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };

    // 初始化临时文件目录
    const ws = vscode.workspace.workspaceFolders;
    if (ws && ws[0]) {
      this.tempDir = path.join(ws[0].uri.fsPath, '.ai-temp-outputs');
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    }

    webviewView.webview.html = getChatWebviewContent(webviewView.webview, this._extensionUri);

    webviewView.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      undefined,
      this._context.subscriptions
    );

    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.updateApiKeyStatus(); });
    this.updateApiKeyStatus();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiAssistant')) {
        openAIClient.refreshConfig();
        this.updateApiKeyStatus();
      }
    });
  }

  // ========== 消息路由 ==========

  private async handleWebviewMessage(message: {
    command: string; content?: string; mode?: string; id?: string;
    settings?: any; approved?: boolean; action?: string;
    attachedFiles?: { fileName: string; content: string; language: string }[];
  }): Promise<void> {
    switch (message.command) {
      case 'sendMessage':
        await this.handleUserMessage(message.content || '', (message.mode as ChatMode) || this.currentMode, message.attachedFiles || []);
        break;
      case 'switchMode':
        this.currentMode = (message.mode as ChatMode) || 'assistant';
        break;
      case 'clearChat':
        this.clearCurrentModeHistory();
        break;
      case 'attachFile': await this.handleAttachFile(); break;
      case 'getSettings': this.handleGetSettings(); break;
      case 'saveSettings': await this.handleSaveSettings(message.settings); break;
      case 'approveActions':
        this.resolveApproval(message.approved !== false);
        break;
      case 'rollbackAgent':
        this.handleRollback();
        break;
      case 'toggleEditMode':
        await this.handleToggleEditMode();
        break;
      case 'requestClearHistory':
        this.handleRequestClearHistory();
        break;
      case 'confirmClearHistory':
        this.handleConfirmClearHistory();
        break;
      case 'pauseAgent':
        this.handlePauseAgent();
        break;
      case 'resumeAgent':
        this.handleResumeAgent();
        break;
      case 'stopAgent':
        this.handleStopAgent();
        break;
      case 'getSkills':
        this.sendSkillsToWebview();
        break;
      case 'importSkill':
        this.handleImportSkill();
        break;
      case 'toggleSkill':
        this.handleToggleSkill(message.id || '');
        break;
      case 'removeSkill':
        this.handleRemoveSkill(message.id || '');
        break;
    }
  }

  private getCurrentHistory(): ChatMessage[] {
    return this.currentMode === 'agent' ? this.agentHistory : this.assistantHistory;
  }

  private setCurrentHistory(history: ChatMessage[]): void {
    if (this.currentMode === 'agent') this.agentHistory = history;
    else this.assistantHistory = history;
  }

  // ========== 核心：处理用户消息 ==========

  private async handleUserMessage(
    text: string, mode: ChatMode,
    attachedFiles: { fileName: string; content: string; language: string }[]
  ): Promise<void> {
    this.currentMode = mode;

    const userContent = this.buildUserContent(text, attachedFiles);

    if (mode === 'assistant') {
      this.assistantHistory.push({ role: 'user', content: userContent });
      this.trimChatHistory();
    } else {
      // Agent 模式（Cody）
      this.agentHistory.push({ role: 'user', content: userContent });
      this.trimChatHistory();
    }

    this.cancelStreaming();
    this.agentRunning = true;
    this.agentPaused = false;
    this.agentStopped = false;
    this.snapshotManager = new SnapshotManager();
    this.taskManager = new TaskManager();

    this.postMessage('agentStatus', { running: true, paused: false });

    try {
      if (mode === 'agent') {
        await this.runAgentLoop();
      } else {
        await this.runAssistantRequest();
      }
    } catch (error) {
      if ((error as Error).message === '请求已被取消') { return; }
      this.postMessage('streamError', { content: `请求失败: ${(error as Error).message}` });
    } finally {
      this.agentRunning = false;
      this.agentPaused = false;
      this.postMessage('agentStatus', { running: false, paused: false });
    }
  }

  /** Assistant 模式：一次请求直接返回 */
  private async runAssistantRequest(): Promise<void> {
    let full = '';
    this.abortController = new AbortController();
    await openAIClient.streamChatCompletion(
      { model: Settings.chatModel, messages: [{ role: 'system', content: Settings.chatSystemPrompt }, ...this.assistantHistory] },
      (chunk) => { full += chunk; this.postMessage('streamChunk', { content: chunk }); },
      this.abortController.signal
    );
    this.postMessage('streamEnd', {});
    // 记录 assistant 回应到历史（用于上下文）
    if (full) { this.assistantHistory.push({ role: 'assistant', content: full }); }
    // 过长输出折叠（仅影响 UI，历史保持完整）
    await this.collapseLongMessages();
  }

  /** Agent 循环：工具调用 → 执行 → 结果反馈 → 继续 */
  private async runAgentLoop(): Promise<void> {
    const skillsPrompt = this.skillManager.buildSkillsPrompt();
    const agentSysMsg = buildAgentSystemPrompt(skillsPrompt);
    let round = 0;
    // 重复操作熔断
    let lastToolKey = '';
    let consecutiveDuplicates = 0;
    // Todo 提醒计数
    let roundsSinceTodo = 0;

    while (round < Settings.maxAgentRounds) {
      // 检查暂停/停止状态
      if (this.agentStopped) {
        this.agentStopped = false;
        return;
      }
      while (this.agentPaused) {
        await this.delay(200);
        if (this.agentStopped) {
          this.agentStopped = false;
          return;
        }
      }

      round++;

      // 第二轮及以后：通知 webview 创建新的流式消息占位
      if (round > 1) {
        this.postMessage('prepareAgentStream', {});
      }

      this.abortController = new AbortController();
      let fullOutput = '';
      const historyForAI = this.agentHistory.slice();

      try {
        // **缓冲全部输出，不直接推送 UI**，使用 Agent 专用参数
        await openAIClient.streamChatCompletion(
          {
            model: Settings.chatModel,
            messages: [{ role: 'system', content: agentSysMsg }, ...historyForAI],
            max_tokens: Settings.agentMaxTokens,
            temperature: Settings.agentTemperature,
          },
          (chunk) => {
            fullOutput += chunk;
          },
          this.abortController.signal
        );
      } catch (streamError) {
        const msg = (streamError as Error).message;
        if (msg === '请求已被取消') {
          // 取消后检查标记：如果只是暂停则继续循环，停止则由外层处理
          if (this.agentStopped) { return; }
          continue;
        }
        throw streamError;
      }

      // 解析工具调用（从完整输出中剥离 ```tool 块）
      const { text: cleanText, toolCalls } = parseToolCalls(fullOutput);

      if (!cleanText && toolCalls.length === 0) {
        // 空响应：尝试重试一次（带引导提示）
        if (round === 1) {
          this.postMessage('agentToolResult', {
            content: '> 🔄 AI 首轮返回空响应，正在重试...',
          });
          this.agentHistory.push({
            role: 'user',
            content: '（系统提示：你上一轮没有返回有效内容。请直接给出回答，或使用工具来获取所需信息。如果需要读取文件但工具失败，请尝试列出目录确认文件名后再读。保持简洁，不需要重复之前的分析。）',
          });
          continue;
        }
        // 重试后仍为空 → 友好提示
        this.postMessage('agentToolResult', {
          content: '> 💤 AI 未返回有效内容。可能是上下文过长或请求过于复杂，请尝试简化问题或清除历史后重试。',
        });
        this.postMessage('streamEnd', {});
        return;
      }

      // 将本轮 AI 完整输出（含工具块）推入历史供后续上下文
      this.agentHistory.push({ role: 'assistant', content: fullOutput });

      if (toolCalls.length === 0) {
        // AI 纯文本回复（无工具调用），分片显示并折叠
        if (cleanText) {
          this.postStreamText(cleanText);
        }
        this.postMessage('streamEnd', {});
        await this.collapseLongMessages();
        return;
      }

      // 有工具调用时，发送摘要文本（不含命令块）并结束流
      if (cleanText) {
        this.postStreamText(cleanText);
      }
      this.postMessage('streamEnd', {});
      // 过长文本部分也折叠
      await this.collapseLongMessages();

      // ===== 有工具调用 =====
      const editMode = Settings.agentEditMode;
      const hasDangerous = toolCalls.some(tc => isDangerous(tc.name));
      const hasWrite = toolCalls.some(tc => tc.name === 'write_file' || tc.name === 'delete_file');

      if (editMode === 'normal' && hasWrite) {
        // 一般模式 → 发送审批请求
        this.postMessage('showApproval', {
          toolCalls: toolCalls.map(tc => ({
            name: tc.name,
            summary: this.describeAction(tc),
            dangerous: isDangerous(tc.name),
          })),
        });

        const approved = await this.waitForApproval();
        if (!approved) {
          this.postMessage('agentToolResult', { content: '⏸️ 编辑操作已取消。' });
          this.agentHistory.push({ role: 'assistant', content: '用户取消了编辑操作。' });
          return;
        }
      }

      // 危险操作提示
      if (hasDangerous) {
        this.postMessage('agentToolResult', { content: '⚠️ **检测到危险操作，正在执行...**' });
      }

      // 执行前保存快照
      if (hasWrite) {
        for (const tc of toolCalls) {
          if (tc.name === 'write_file' || tc.name === 'delete_file') {
            await this.snapshotBeforeModify(tc);
          }
        }
        this.postMessage('snapshotUpdate', { count: this.snapshotManager.count });
      }

      // 执行工具
      const results: ToolResult[] = [];
      for (const tc of toolCalls) {
        // 重复操作检测（v1.3 熔断机制）
        const argKey = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        if (argKey === lastToolKey) {
          consecutiveDuplicates++;
          if (consecutiveDuplicates >= 3) {
            this.postMessage('agentToolResult', {
              content: `> ⚠️ 检测到连续 3 次重复操作 \`${tc.name}\`，Agent 已熔断停止。`,
            });
            this.agentHistory.push({
              role: 'user',
              content: 'WARNING: 你连续执行了相同的操作。请停止重复操作，输出当前分析结果。如果任务已完成，请直接给出最终回答。',
            });
            return;
          }
        } else {
          lastToolKey = argKey;
          consecutiveDuplicates = 1;
        }

        const result = await executeTool(tc);
        results.push(result);
        // 检测 todo 工具使用
        if (tc.name === 'todo') { roundsSinceTodo = 0; }
      }

      roundsSinceTodo++;

      // 工具结果摘要 → 独立消息（含可展开详情）
      const summary = formatToolResultsSummary(results);
      const details = formatToolResultsDetails(results);
      this.postMessage('agentToolResult', { summary, details });

      // 刷新 VSCode 编辑器
      await this.refreshOpenEditors(results);

      // **关键**：工具结果作为 user 消息反馈给 AI（推进下一轮思考）
      const resultMsg = formatToolResultsForAI(results);
      this.agentHistory.push({ role: 'user', content: resultMsg });

      // Todo 提醒：连续 3 轮未更新 todo → 注入系统提醒
      if (roundsSinceTodo >= 3) {
        this.agentHistory.push({
          role: 'user',
          content: '<SYSTEM REMINDER> 你已连续 3 轮没有更新 todo 列表。请更新任务进度（status: pending/in_progress/completed）来追踪进度。',
        });
        roundsSinceTodo = 0;
      }
    }

    // 达到最大轮数
    this.postMessage('agentToolResult', {
      content: `> ⚠️ 已达到最大操作轮数（${Settings.maxAgentRounds}轮）限制，Agent 已暂停。发送新消息可继续。`,
    });
  }

  /** 修改前创建文件快照 */
  private async snapshotBeforeModify(tc: ToolCall): Promise<void> {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws) { return; }
    const rootPath = ws[0].uri.fsPath;
    const filePath = (tc.arguments.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const absPath = require('path').join(rootPath, filePath);

    if (tc.name === 'write_file' && require('fs').existsSync(absPath)) {
      const original = require('fs').readFileSync(absPath, 'utf-8');
      this.snapshotManager.snapshot(absPath, original);
    } else if (tc.name === 'delete_file' && require('fs').existsSync(absPath)) {
      const original = require('fs').readFileSync(absPath, 'utf-8');
      this.snapshotManager.snapshot(absPath, original);
    }
  }

  /** 刷新 VSCode 中已打开的编辑器 */
  private async refreshOpenEditors(results: ToolResult[]): Promise<void> {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws) { return; }
    const rootPath = ws[0].uri.fsPath;

    for (const r of results) {
      if (!r.success || (r.name !== 'write_file' && r.name !== 'delete_file')) { continue; }
      const filePath = (r.arguments.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      const absPath = require('path').join(rootPath, filePath);
      const uri = vscode.Uri.file(absPath);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        // 不自动打开，只是通知 VSCode 文件变了
      } catch { /* 文件可能未打开 */ }
    }
  }

  /** 回滚所有 Agent 修改 */
  private handleRollback(): void {
    const restored = this.snapshotManager.rollbackAll();
    if (restored.length > 0) {
      this.postMessage('addMessage', {
        role: 'assistant',
        content: `🔄 **已回滚 ${restored.length} 个文件：**\n${restored.map(f => '• ' + f).join('\n')}`,
      });
    } else {
      this.postMessage('addMessage', { role: 'assistant', content: '没有需要回滚的修改。' });
    }
  }

  /** 切换编辑模式 */
  private async handleToggleEditMode(): Promise<void> {
    const current = Settings.agentEditMode;
    const next: 'normal' | 'fast' = current === 'normal' ? 'fast' : 'normal';
    await Settings.setAgentEditMode(next);
    this.postMessage('editModeChanged', { mode: next });
  }

  // ========== 审批流程 ==========

  private waitForApproval(): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovalResolve = resolve;
    });
  }

  private resolveApproval(approved: boolean): void {
    if (this.pendingApprovalResolve) {
      const resolve = this.pendingApprovalResolve;
      this.pendingApprovalResolve = null;
      resolve(approved);
    }
  }

  /** 描述工具操作用人类语言 */
  private describeAction(tc: ToolCall): string {
    const p = tc.arguments.path || '';
    const c = tc.arguments.content || '';
    switch (tc.name) {
      case 'write_file':
        return c.length > 400
          ? `✏️ 写入 **${p}** (${c.length} 字符)`
          : `✏️ 写入 **${p}**\n\`\`\`\n${c}\n\`\`\``;
      case 'delete_file':
        return `🗑️ 删除 **${p}**`;
      case 'read_file':
        return `📖 读取 **${p}**`;
      case 'list_files':
        return `📂 列出目录 **${tc.arguments.dir || '/'}**`;
      case 'search_code':
        return `🔍 搜索 **"${tc.arguments.pattern}"**`;
      case 'execute_command':
        return `💻 执行 \`${tc.arguments.cmd}\``;
      default:
        return `${tc.name}`;
    }
  }

  // ========== 其余方法（与原先一致） ==========

  private clearCurrentModeHistory(): void {
    this.setCurrentHistory([]);
    this.cancelStreaming();
    this.snapshotManager = new SnapshotManager();
    this.taskManager = new TaskManager();
    this.postMessage('clearChat', {});
  }

  // ========== 过长输出卸载 ==========

  /**
   * 流结束后检查最后一条 assistant 消息的视觉高度：
   * - 通知 webview 检测高度，超过阈值则自动折叠
   * - 超过 TEMPFILE_THRESHOLD 时也写入临时文件
   * AI 对话历史始终保留完整原文
   */
  private async collapseLongMessages(): Promise<void> {
    const history = this.getCurrentHistory();
    if (history.length === 0) return;

    const last = history[history.length - 1];
    if (last.role !== 'assistant') return;

    // 超过超长阈值 → 写入临时文件
    let filePath = '';
    if (last.content.length > TEMPFILE_THRESHOLD) {
      filePath = (await this.writeTempFile(last)) || '';
    }

    // 通知 webview：检测高度并折叠
    this.postMessage('collapseMessage', { filePath });
  }

  private async writeTempFile(msg: ChatMessage): Promise<string | null> {
    if (!this.tempDir) return null;
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `ai-output-${ts}.md`;
      const filePath = path.join(this.tempDir, filename);
      fs.writeFileSync(filePath, msg.content, 'utf-8');
      this.tempFiles.add(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  // ========== 清除历史确认 ==========

  private handleRequestClearHistory(): void {
    const paths = Array.from(this.tempFiles);
    this.postMessage('showClearConfirm', {
      tempFiles: paths.map(p => path.basename(p)),
      tempDir: this.tempDir,
    });
  }

  private handleConfirmClearHistory(): void {
    // 删除所有临时文件
    for (const p of this.tempFiles) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    this.tempFiles.clear();
    // 清除历史
    this.clearCurrentModeHistory();
  }

  // ========== 解读代码 ==========

  async sendSystemPrompt(prompt: string, contextMessages?: ChatMessage[]): Promise<void> {
    if (!this._view) { return; }
    this._view.show(true);
    this.currentMode = 'agent';
    if (contextMessages) this.agentHistory = [...contextMessages];
    this.postMessage('addMessage', { role: 'user', content: prompt });
    this.agentHistory.push({ role: 'user', content: prompt });
    this.cancelStreaming();
    this.agentRunning = true;
    this.agentPaused = false;
    this.agentStopped = false;
    this.snapshotManager = new SnapshotManager();
    this.postMessage('agentStatus', { running: true, paused: false });
    let full = '';
    try {
      this.abortController = new AbortController();
      await openAIClient.streamChatCompletion(
        { model: Settings.chatModel, messages: [{ role: 'system', content: Settings.chatSystemPrompt }, ...this.agentHistory] },
        (chunk) => { full += chunk; this.postMessage('streamChunk', { content: chunk }); },
        this.abortController.signal
      );
      if (full) this.agentHistory.push({ role: 'assistant', content: full });
      this.postMessage('streamEnd', {});
    } catch (error) {
      if ((error as Error).message === '请求已被取消') return;
      this.postMessage('streamError', { content: `失败: ${(error as Error).message}` });
    } finally {
      this.agentRunning = false;
      this.agentPaused = false;
      this.postMessage('agentStatus', { running: false, paused: false });
    }
  }

  private async handleAttachFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { this.postMessage('streamError', { content: '没有打开的文件' }); return; }
    const d = editor.document;
    this.postMessage('attachFileResult', { file: { fileName: d.fileName.split(/[\\/]/).pop(), content: d.getText().substring(0, 50000), language: d.languageId } });
  }

  private buildUserContent(text: string, files: { fileName: string; content: string; language: string }[]): string {
    if (files.length === 0) return text;
    const blocks: string[] = [];
    for (const f of files) {
      if (!f.content) continue;
      const lang = f.language || this.inferLanguage(f.fileName);
      const maxLen = files.length === 1 ? 20000 : 8000;
      const t = f.content.substring(0, maxLen);
      blocks.push(`### 📄 ${f.fileName}\n\`\`\`${lang}\n${t}\n\`\`\``);
    }
    return blocks.length === 0 ? text : `参考文件${files.length > 1 ? `（共${files.length}个）` : ''}：\n\n${blocks.join('\n\n')}\n\n---\n\n${text}`;
  }

  private trimChatHistory(): void {
    const max = MAX_HISTORY_ROUNDS * 2;
    const history = this.getCurrentHistory();
    if (history.length > max) this.setCurrentHistory(history.slice(-max));
  }

  private handleGetSettings(): void {
    this.postMessage('settingsLoaded', {
      settings: {
        apiBaseUrl: Settings.apiBaseUrl,
        apiKey: Settings.apiKey,
        completionApiBaseUrl: Settings.completionApiBaseUrl,
        completionApiKey: Settings.completionApiKey,
        completionModel: Settings.completionModel,
        chatModel: Settings.chatModel,
        chatThinkingFormat: Settings.chatThinkingFormat,
        chatThinkingEnabled: Settings.chatThinkingEnabled,
        completionThinkingFormat: Settings.completionThinkingFormat,
        completionMode: Settings.completionMode,
        chatSystemPrompt: Settings.chatSystemPrompt,
        maxAgentRounds: Settings.maxAgentRounds,
        agentMaxTokens: Settings.agentMaxTokens,
        agentTemperature: Settings.agentTemperature,
      },
      defaults: DEFAULTS,
    });
  }

  private async handleSaveSettings(s: any): Promise<void> {
    try {
      // 逐字段保存：匹配推荐默认值时写 undefined（清除用户覆盖），缺失字段跳过不动
      const fields: [string, string | number | boolean][] = [
        ['apiBaseUrl', s.apiBaseUrl],
        ['apiKey', s.apiKey],
        ['completionApiBaseUrl', s.completionApiBaseUrl],
        ['completionApiKey', s.completionApiKey],
        ['completionModel', s.completionModel],
        ['chatModel', s.chatModel],
        ['chatThinkingFormat', s.chatThinkingFormat],
        ['chatThinkingEnabled', s.chatThinkingEnabled],
        ['completionThinkingFormat', s.completionThinkingFormat],
        ['completionMode', s.completionMode],
        ['chatSystemPrompt', s.chatSystemPrompt],
        ['maxAgentRounds', s.maxAgentRounds],
        ['agentMaxTokens', s.agentMaxTokens],
        ['agentTemperature', s.agentTemperature],
      ];
      for (const [key, val] of fields) {
        if (val === undefined) continue; // 字段不存在，不修改
        const def = (DEFAULTS as any)[key];
        await Settings.set(key, val === def ? undefined : val);
      }
      openAIClient.refreshConfig();
      this.updateApiKeyStatus();
      this.postMessage('settingsSaved', { settings: { apiKey: Settings.apiKey } });
    } catch (error) {
      this.postMessage('settingsError', { content: `保存失败: ${(error as Error).message}` });
    }
  }

  private postMessage(command: string, data: any): void {
    if (this._view) this._view.webview.postMessage({ command, ...data });
  }

  /** 分片发送超长文本到 streamChunk，避免单条 postMessage 数据量过大导致截断 */
  private postStreamText(text: string, chunkSize: number = 10000): void {
    for (let i = 0; i < text.length; i += chunkSize) {
      this.postMessage('streamChunk', { content: text.substring(i, i + chunkSize) });
    }
  }

  private updateApiKeyStatus(): void {
    this.postMessage('apiKeyStatus', { hasKey: Settings.hasApiKey() });
  }

  private cancelStreaming(): void {
    if (this.abortController) { this.abortController.abort(); this.abortController = undefined; }
    this.resolveApproval(false);
  }

  // ========== Agent 暂停/停止/继续 ==========

  private handlePauseAgent(): void {
    this.agentPaused = true;
    this.cancelStreaming(); // 取消当前正在进行的 API 请求
    this.postMessage('agentStatus', { running: true, paused: true });
    this.postMessage('agentToolResult', { content: '⏸️ Agent 已暂停。点击「▶ 继续」恢复执行。' });
  }

  private handleResumeAgent(): void {
    this.agentPaused = false;
    this.postMessage('agentStatus', { running: true, paused: false });
    this.postMessage('agentToolResult', { content: '▶️ Agent 继续执行...' });
  }

  private handleStopAgent(): void {
    this.agentStopped = true;
    this.agentPaused = false;
    this.cancelStreaming();
    this.resolveApproval(false);
    this.postMessage('agentStatus', { running: false, paused: false });
    this.postMessage('agentToolResult', { content: '⏹️ Agent 已停止。你可以重新输入指令。' });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ========== SKILL 管理 ==========

  /** 将当前 SKILL 列表发送到 Webview */
  sendSkillsToWebview(): void {
    const skills = this.skillManager.getAll();
    this.postMessage('skillsLoaded', { skills });
  }

  private async handleImportSkill(): Promise<void> {
    // 委托到 VSCode 命令（打开文件选择器）
    await vscode.commands.executeCommand('aiAssistant.importSkill');
  }

  private handleToggleSkill(id: string): void {
    this.skillManager.toggleEnabled(id);
    this.sendSkillsToWebview();
  }

  private handleRemoveSkill(id: string): void {
    this.skillManager.remove(id);
    this.sendSkillsToWebview();
  }

  private inferLanguage(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const m: Record<string, string> = { 'ts': 'typescript', 'tsx': 'tsx', 'js': 'javascript', 'jsx': 'jsx', 'py': 'python', 'java': 'java', 'go': 'go', 'rs': 'rust', 'cpp': 'cpp', 'c': 'c', 'h': 'c', 'hpp': 'cpp', 'cs': 'csharp', 'rb': 'ruby', 'php': 'php', 'swift': 'swift', 'kt': 'kotlin', 'scala': 'scala', 'r': 'r', 'sql': 'sql', 'sh': 'bash', 'yaml': 'yaml', 'yml': 'yaml', 'json': 'json', 'xml': 'xml', 'html': 'html', 'css': 'css', 'scss': 'scss', 'vue': 'vue', 'md': 'markdown', 'toml': 'toml' };
    return m[ext] || ext || 'plaintext';
  }
}
