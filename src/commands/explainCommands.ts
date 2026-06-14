import * as vscode from 'vscode';
import { openAIClient } from '../api/openaiClient';
import { ChatPanelProvider } from '../chat/chatPanel';

/**
 * 代码解读命令注册
 *
 * 提供两个核心命令：
 * 1. explainSelection - 解读选中的代码
 * 2. explainFile - 解读整个当前文件
 */
export function registerExplainCommands(
  context: vscode.ExtensionContext,
  chatPanelProvider: ChatPanelProvider
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  /**
   * 解读选中代码
   * 快捷键: Ctrl+Shift+E (Windows/Linux) / Cmd+Shift+E (Mac)
   */
  disposables.push(
    vscode.commands.registerCommand('aiAssistant.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('请先打开一个文件并选中代码');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('请先选中要解读的代码');
        return;
      }

      const selectedCode = editor.document.getText(selection);
      const language = editor.document.languageId;
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || '未知文件';

      // 限制代码长度
      let code = selectedCode;
      if (code.length > 8000) {
        code = code.substring(0, 8000) + '\n// ... (代码已截断)';
      }

      const prompt = `请解读以下 ${fileName} 文件中选中的 ${language} 代码`;

      const messages = openAIClient.buildExplainPrompt(
        code,
        language,
        `这段代码来自文件 ${fileName}`
      );

      await chatPanelProvider.sendSystemPrompt(prompt, messages);
    })
  );

  /**
   * 解读当前文件
   */
  disposables.push(
    vscode.commands.registerCommand('aiAssistant.explainFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('请先打开一个文件');
        return;
      }

      const document = editor.document;
      const code = document.getText();
      const language = document.languageId;
      const fileName = document.fileName.split(/[\\/]/).pop() || '未知文件';

      // 限制文件大小
      let truncatedCode = code;
      if (truncatedCode.length > 12000) {
        truncatedCode = truncatedCode.substring(0, 12000) + '\n// ... (文件内容已截断)';
      }

      const prompt = `请解读整个文件 ${fileName} 的代码结构和功能`;

      const messages = openAIClient.buildExplainPrompt(
        truncatedCode,
        language,
        `这是一个完整的文件 ${fileName}`
      );

      await chatPanelProvider.sendSystemPrompt(prompt, messages);
    })
  );

  /**
   * 切换代码补全开关
   */
  disposables.push(
    vscode.commands.registerCommand('aiAssistant.toggleCompletion', async () => {
      const config = vscode.workspace.getConfiguration('aiAssistant');
      const currentValue = config.get<boolean>('enableCompletion', true);
      await config.update('enableCompletion', !currentValue, vscode.ConfigurationTarget.Global);

      if (!currentValue) {
        vscode.window.showInformationMessage('✅ Cody 代码补全已启用');
      } else {
        vscode.window.showInformationMessage('⏸️ Cody 代码补全已暂停');
      }
    })
  );

  /**
   * 打开对话面板
   */
  disposables.push(
    vscode.commands.registerCommand('aiAssistant.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.aiAssistantSidebar');
    })
  );

  return disposables;
}
