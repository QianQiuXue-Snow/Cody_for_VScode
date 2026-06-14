import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Skill 数据模型
 */
export interface Skill {
  id: string;          // 唯一标识（基于文件名）
  name: string;        // 展示名称
  content: string;     // Prompt 正文
  enabled: boolean;    // 是否启用
  importedAt: number;  // 导入时间戳
}

/**
 * Skill 管理器
 *
 * 负责：
 * - 导入 Markdown/文本文件作为 SKILL
 * - 启用/禁用 SKILL
 * - 移除 SKILL
 * - 将启用的 SKILL 注入 Agent System Prompt
 */
export class SkillManager {
  private static readonly STORAGE_KEY = 'cody.skills';
  private skills: Skill[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.load();
  }

  /** 获取所有 SKILL */
  getAll(): Skill[] {
    return [...this.skills];
  }

  /** 获取已启用的 SKILL */
  getEnabled(): Skill[] {
    return this.skills.filter(s => s.enabled);
  }

  /**
   * 构建注入到 Agent System Prompt 中的 SKILL 上下文
   */
  buildSkillsPrompt(): string {
    const enabled = this.getEnabled();
    if (enabled.length === 0) return '';

    const sections = enabled.map(s => {
      const name = s.name.replace(/\.\w+$/, '').replace(/[-_]/g, ' ');
      return `## ${name}\n\n${s.content}`;
    });

    return `\n## 已加载的 SKILL（领域知识）\n
以下 SKILL 描述了特定领域的编码规范和最佳实践，请在相关任务中严格遵循：\n\n${sections.join('\n\n')}`;
  }

  /**
   * 从文件导入 SKILL
   * @param filePath 文件路径（.md / .txt / .skill）
   */
  async importFromFile(filePath: string): Promise<Skill> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'untitled';
    const name = fileName.replace(/\.(md|txt|skill)$/i, '');
    const id = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');

    // 若已存在同名 → 覆盖
    const existing = this.skills.findIndex(s => s.id === id);
    const skill: Skill = {
      id,
      name,
      content,
      enabled: true,
      importedAt: Date.now(),
    };

    if (existing >= 0) {
      this.skills[existing] = skill;
    } else {
      this.skills.push(skill);
    }
    this.save();
    return skill;
  }

  /** 切换启用/禁用 */
  toggleEnabled(id: string): boolean {
    const skill = this.skills.find(s => s.id === id);
    if (!skill) return false;
    skill.enabled = !skill.enabled;
    this.save();
    return skill.enabled;
  }

  /** 移除 SKILL */
  remove(id: string): boolean {
    const idx = this.skills.findIndex(s => s.id === id);
    if (idx < 0) return false;
    this.skills.splice(idx, 1);
    this.save();
    return true;
  }

  /** 从持久化存储加载 */
  private load(): void {
    try {
      const raw = this.context.globalState.get<string>(SkillManager.STORAGE_KEY);
      if (raw) {
        this.skills = JSON.parse(raw);
      }
    } catch {
      this.skills = [];
    }
  }

  /** 持久化到存储 */
  private save(): void {
    this.context.globalState.update(SkillManager.STORAGE_KEY, JSON.stringify(this.skills));
  }
}
