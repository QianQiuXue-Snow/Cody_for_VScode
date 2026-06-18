/**
 * 补全结果清洗模块 — 提供 inline & dropdown 共用
 *
 * 策略（由弱到强）：
 * 1. Markdown code fence 去除
 * 2. 去掉与 codeBefore 尾部重复的开头（逐字符比对）
 * 3. 将补全结果中与 codeBefore 已存在的行全部切除
 * 4. 检查补全中包含 codeAfter 开头的部分，在碰到的位置截断
 * 5. 去掉纯空白 / 过短的无效结果
 * 6. 截断到最后一个语义完整的行
 * 7. 最终验证：若结果与现有上下文高度重叠（>70%），丢弃
 */

/**
 * 清洗一条 AI 补全结果。
 * @returns 清洗后的文本，或 null 表示应丢弃
 */
export function cleanCompletion(
  completion: string,
  codeBefore: string,
  codeAfter: string,
  _language?: string
): string | null {
  // ===== 0. 原始清洗 =====
  let text = completion;

  // 去掉 markdown 代码块标记
  text = text.replace(/^```[\w]*\n?/g, '').replace(/\n?```$/g, '');
  text = text.trim();
  if (text.length === 0) return null;

  // ===== 1. 逐字符去掉与 codeBefore 重叠的开头 =====
  text = stripLeadingOverlap(text, codeBefore);

  // ===== 2. 切除已存在于上下文中的完整行 =====
  text = stripExistingLinesAggressive(text, codeBefore);

  // ===== 3. 若补全与 codeAfter 开头有交集，截断 =====
  text = trimAtCodeAfterStart(text, codeAfter);

  // ===== 4. 去空白 / 过短拒绝 =====
  text = text.trim();
  if (text.length === 0) return null;
  if (/^[\s\t\n\r]+$/.test(text)) return null;
  // 拒绝仅 1 个字符且非配对符号
  if (text.length <= 1 && !/[)\]\}"'` ]$/.test(text)) return null;

  // ===== 5. 截断到最后一个语义完整的行 =====
  text = truncateToCompleteBlock(text);
  if (!text) return null;

  // ===== 6. 若清洗后的结果与 codeBefore 后半部分高度重叠，丢弃 =====
  if (isDuplicateOfContext(text, codeBefore)) return null;

  return text;
}

// ============================================================
//  内部函数
// ============================================================

/**
 * 逐字符去掉补全开头与 codeBefore 尾部重叠的部分。
 * 例如 codeBefore="console.log(" 补全="console.log('hello')" → "('hello')"
 */
function stripLeadingOverlap(text: string, codeBefore: string): string {
  const tail = codeBefore.length > 300 ? codeBefore.slice(-300) : codeBefore;
  let maxMatch = 0;

  // 从最长可能匹配开始（取 min(text, tail)）
  for (let i = Math.min(text.length, tail.length); i > 0; i--) {
    const tailEnd = tail.slice(-i);
    const textStart = text.slice(0, i);
    if (tailEnd === textStart) {
      maxMatch = i;
      break;
    }
  }

  if (maxMatch > 0) {
    return text.slice(maxMatch);
  }
  return text;
}

/**
 * 切除补全中与 codeBefore 中已存在的整行。
 * 与旧版不同：检查补全的*每一行前 N 行*是否在 codeBefore 中出现过。
 */
function stripExistingLinesAggressive(completion: string, codeBefore: string): string {
  const compLines = completion.split('\n');
  const contextLines = codeBefore.split('\n');
  const contextSet = new Set(contextLines.map(l => l.trim()));

  if (contextSet.size === 0) return completion;

  // 从开头检查：连续匹配的行全部移除
  let stripFromStart = 0;
  for (let i = 0; i < compLines.length; i++) {
    const line = compLines[i].trim();
    // 空行：如果后续还有内容且下一行也匹配，也跳过；否则停止
    if (line.length === 0) {
      if (i + 1 < compLines.length && contextSet.has(compLines[i + 1].trim())) {
        stripFromStart = i + 1;
        continue;
      }
      break;
    }
    if (contextSet.has(line)) {
      stripFromStart = i + 1;
    } else {
      break;
    }
  }

  return stripFromStart > 0 ? compLines.slice(stripFromStart).join('\n') : completion;
}

/**
 * 检查补全末尾是否包含了 codeAfter 开头的内容，在重合处截断。
 */
function trimAtCodeAfterStart(text: string, codeAfter: string): string {
  const afterFirstLine = codeAfter.trimStart().split('\n')[0] || '';
  if (afterFirstLine.length < 2) return text; // 太短不判断

  const idx = text.indexOf(afterFirstLine);
  if (idx > 0) {
    return text.substring(0, idx).trimEnd();
  }
  return text;
}

/**
 * 截断到最后一个语义完整的行。
 * "完整" = 以 ; {} () ] > " ' ` 结尾，或以 : 结尾（Python/TS 冒号），
 * 或不以运算符结尾。
 */
function truncateToCompleteBlock(text: string): string {
  const lines = text.split('\n');

  // 去尾部空行
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) return '';

  // 从最后一行往前找完整行
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trimEnd();
    if (isCompleteLine(line)) {
      // 找到最后一个完整行 → 保留到这一行
      return lines.slice(0, i + 1).join('\n');
    }
  }
  // 没找到完整行 → 只保留第一行
  return lines[0];
}

function isCompleteLine(line: string): boolean {
  if (line.length === 0) return true;
  // 以下列字符结尾 → 语义完整
  if (/[;{})\]>'"`]$/.test(line)) return true;
  // 冒号结尾（if/for/def/class: 等）
  if (line.endsWith(':')) return true;
  // 以运算符结尾 → 不完整（需要下一行）
  if (/[+\-*/%=<>!&|^~,]$/.test(line)) return false;
  // 其他 → 认为完整
  return true;
}

/**
 * 检查清洗后的结果是否本质上是 codeBefore 中已经存在的代码。
 * 简单的启发式：若清洗结果的所有行中存在 ≥70% 的行在上下文中出现，则丢弃。
 */
function isDuplicateOfContext(text: string, codeBefore: string): boolean {
  const compLines = text.split('\n').filter(l => l.trim().length > 0);
  if (compLines.length === 0) return true;

  const contextLines = codeBefore.split('\n');
  const contextSet = new Set(contextLines.map(l => l.trim()));

  let matched = 0;
  for (const line of compLines) {
    if (contextSet.has(line.trim())) {
      matched++;
    }
  }

  // 超过 70% 的行都是已有的 → 视为重复
  return compLines.length > 0 && (matched / compLines.length) > 0.7;
}
