import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { Settings } from '../config/settings';

/**
 * Chat Message 类型定义（OpenAI 兼容格式）
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Chat Completion 请求参数
 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string[];
}

/**
 * Chat Completion 响应中的 Choice
 */
export interface ChatChoice {
  index: number;
  message?: {
    role: string;
    content: string;
  };
  delta?: {
    role?: string;
    content?: string;
  };
  finish_reason: string | null;
}

/**
 * 流式响应增量回调
 */
export type StreamChunkCallback = (content: string) => void;

/**
 * OpenAI 兼容 API 客户端
 *
 * 支持：
 * - 非流式请求（用于代码补全）
 * - 流式请求（SSE，用于聊天对话）
 * - 自定义 API Base URL（兼容第三方 API 代理）
 */
export class OpenAIClient {
  /** 对话用 */
  private chatBaseUrl: string;
  private chatApiKey: string;
  /** 补全用 */
  private compBaseUrl: string;
  private compApiKey: string;
  /** 思考参数格式 */
  private chatThinkFmt: string;
  private compThinkFmt: string;
  /** 是否启用 */
  private chatThink: boolean;

  constructor() {
    this.chatBaseUrl = Settings.apiBaseUrl;
    this.chatApiKey = Settings.apiKey;
    this.compBaseUrl = Settings.completionApiBaseUrl;
    this.compApiKey = Settings.completionApiKey;
    this.chatThinkFmt = Settings.chatThinkingFormat;
    this.compThinkFmt = Settings.completionThinkingFormat;
    this.chatThink = Settings.chatThinkingEnabled;
  }

  refreshConfig(): void {
    this.chatBaseUrl = Settings.apiBaseUrl;
    this.chatApiKey = Settings.apiKey;
    this.compBaseUrl = Settings.completionApiBaseUrl;
    this.compApiKey = Settings.completionApiKey;
    this.chatThinkFmt = Settings.chatThinkingFormat;
    this.compThinkFmt = Settings.completionThinkingFormat;
    this.chatThink = Settings.chatThinkingEnabled;
  }

  /** 根据格式构建思考模式参数 */
  private buildThinkingBody(fmt: string, enabled: boolean): Record<string, any> | null {
    if (fmt === 'none') return null;
    if (fmt === 'qwen') return { chat_template_kwargs: { enable_thinking: enabled } };
    if (fmt === 'ollama') return { think: enabled };
    if (fmt === 'anthropic') return { extra_body: { thinking: { type: enabled ? 'enabled' : 'disabled' } } };
    // minimax / default
    return { extra_body: { thinking: enabled } };
  }

  /** 拼装 URL（传入不带协议的基础 URL） */
  private buildUrl(base: string, endpoint: string): URL {
    if (!base.endsWith('/')) base += '/';
    return new URL(endpoint, base);
  }

  /** 发起 HTTP POST 请求 */
  private async httpPost(
    baseUrl: string, apiKey: string, endpoint: string,
    bodyObj: Record<string, any>,
    expectStream: boolean,
    onChunk?: StreamChunkCallback,
    abortSignal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<string> {
    const url = this.buildUrl(baseUrl, endpoint);
    const isHttps = url.protocol === 'https:';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': '',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify(bodyObj);
    headers['Content-Length'] = String(Buffer.byteLength(body));

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(options, (res) => {
        if (!expectStream) {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              let em = `API 请求失败 (${res.statusCode})`;
              try { const eb = JSON.parse(data); em = eb.error?.message || em; } catch {}
              reject(new Error(em));
              return;
            }
            try {
              const resp = JSON.parse(data);
              const content = resp.choices?.[0]?.message?.content;
              if (!content) { reject(new Error('API 返回的内容为空')); return; }
              resolve(content);
            } catch (e) { reject(new Error(`解析失败: ${(e as Error).message}`)); }
          });
          return;
        }

        // 流式
        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            let em = `API 请求失败 (${res.statusCode})`;
            try { const eb = JSON.parse(data); em = eb.error?.message || em; } catch {}
            reject(new Error(em));
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const c = parsed.choices?.[0]?.delta?.content;
              if (c && onChunk) onChunk(c);
            } catch {}
          }
        });
        res.on('end', () => {
          if (buffer.trim()) {
            const t = buffer.trim();
            if (t.startsWith('data: ') && t.slice(6) !== '[DONE]') {
              try {
                const parsed = JSON.parse(t.slice(6));
                const c = parsed.choices?.[0]?.delta?.content;
                if (c && onChunk) onChunk(c);
              } catch {}
            }
          }
          resolve('');
        });
      });

      req.on('error', (e: Error) => reject(new Error(`网络请求失败: ${e.message}`)));

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('请求已被取消'));
        });
      }

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`请求超时（${timeoutMs / 1000}秒）`));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * 非流式请求 — 补全用（禁用思考模式）
   */
  private async completionRequest(request: ChatCompletionRequest): Promise<string> {
    const bodyObj: Record<string, any> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens ?? Settings.maxTokens,
      temperature: request.temperature ?? Settings.temperature,
      stream: false,
      stop: request.stop,
    };
    const thinkBody = this.buildThinkingBody(this.compThinkFmt, false);
    if (thinkBody) Object.assign(bodyObj, thinkBody);
    return this.httpPost(this.compBaseUrl, this.compApiKey, 'chat/completions', bodyObj, false, undefined, undefined, 15000);
  }

  /**
   * 流式请求 — 对话用（按配置开关思考模式）
   */
  private async chatStreamRequest(
    request: ChatCompletionRequest,
    onChunk: StreamChunkCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const bodyObj: Record<string, any> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens ?? 2048,
      temperature: request.temperature ?? 0.7,
      stream: true,
      stop: request.stop,
    };
    const thinkBody = this.buildThinkingBody(this.chatThinkFmt, this.chatThink);
    if (thinkBody) Object.assign(bodyObj, thinkBody);
    await this.httpPost(this.chatBaseUrl, this.chatApiKey, 'chat/completions', bodyObj, true, onChunk, abortSignal, 60000);
  }

  // ===== 兼容旧接口（内部委托到上述两个方法）=====

  /** @deprecated 使用 completionRequest */
  async chatCompletion(request: ChatCompletionRequest): Promise<string> {
    return this.completionRequest(request);
  }

  /** @deprecated 使用 chatStreamRequest */
  async streamChatCompletion(
    request: ChatCompletionRequest,
    onChunk: StreamChunkCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    return this.chatStreamRequest(request, onChunk, abortSignal);
  }

  /**
   * 构建代码补全 Prompt
   */
  buildCompletionPrompt(codeBefore: string, codeAfter: string, language: string): ChatMessage[] {
    // 更小上下文 → 更快推理
    const truncBefore = codeBefore.length > 300 ? codeBefore.slice(-300) : codeBefore;
    const truncAfter = codeAfter.length > 80 ? codeAfter.slice(0, 80) : codeAfter;

    const systemPrompt = `只输出补全代码。`;
    const userPrompt = `${truncBefore}<FILL_HERE>${truncAfter}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /**
   * 代码补全请求
   */
  async getCompletion(
    codeBefore: string,
    codeAfter: string,
    language: string
  ): Promise<string> {
    const messages = this.buildCompletionPrompt(codeBefore, codeAfter, language);

    return this.chatCompletion({
      model: Settings.completionModel,
      messages,
      max_tokens: Settings.maxTokens,
      temperature: Settings.temperature,
      // 不设 stop：让模型自然结束，多行代码块不会被打断
    });
  }

  /**
   * 代码解读 Prompt
   */
  buildExplainPrompt(code: string, language: string, context: string): ChatMessage[] {
    const systemPrompt = '你是一个资深的代码审查专家和编程导师，擅长用清晰易懂的语言解释代码。';
    const userPrompt = `请解读以下${language}代码：

${context}

\`\`\`${language}
${code}
\`\`\`

请从以下几个方面进行解读：
1. **整体功能**：这段代码的主要目的是什么？
2. **关键逻辑**：核心的实现逻辑是怎样的？
3. **值得注意的地方**：有哪些需要特别注意的细节或潜在问题？
4. **优化建议**（可选）：有没有可以改进的地方？`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }
}

/** 全局单例 */
export const openAIClient = new OpenAIClient();
