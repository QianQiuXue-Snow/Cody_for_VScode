# Cody for VSCode

[![VSCode](https://img.shields.io/badge/VSCode-%5E1.66.0-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)

> **Cody** 鈥?鍐呭祵 VSCode 鐨?AI 缂栫▼鍔╂墜锛屾繁搴﹁瀺鍚堝埌缂栬緫鍣ㄥ伐浣滄祦涓紝鎻愪緵瀹炴椂浠ｇ爜琛ュ叏銆佷笅鎷夊€欓€夊垪琛ㄣ€佸杞璇濅互鍙婅嚜涓?Agent 宸ュ叿閾俱€?
## 鏍稿績鍔熻兘

| 鍔熻兘 | 璇存槑 |
|------|------|
| 馃敭 **骞界伒鏂囧瓧琛ュ叏** | 鍏夋爣鍚庡疄鏃舵诞鐜?AI 鐢熸垚鐨勭伆鑹蹭唬鐮侊紝Tab 涓€閿帴鍙?|
| 馃搵 **涓嬫媺鍊欓€夎ˉ鍏?* | 鏈湴鍓嶇紑鍖归厤姣鍑虹粨鏋?+ 鍚庡彴 AI 娴佸紡鏇挎崲鑷抽浣?|
| 馃挰 **Assistant 瀵硅瘽** | 渚ц竟鏍忓崟杞棶绛旓紝鏀寔浠ｇ爜瑙ｉ噴銆佹枃浠跺垎鏋愩€佺煡璇嗘煡璇?|
| 馃 **Agent 宸ュ叿閾?* | 澶氳疆鑷富鎵ц锛氳鍐欐枃浠躲€佹搷浣滄枃妗ｃ€佹墽琛屽懡浠ゃ€佺鐞嗕换鍔¤繘搴?|
| 馃 **SKILL 绯荤粺** | 瀵煎叆 `.md` 鏂囦欢浣滀负 Agent 棰嗗煙鐭ヨ瘑锛屽惎鐢?绂佺敤/绉婚櫎鍙婃煡鐪?|
| 馃寪 **澶氭ā鍨嬭氨绯?* | MiniMax / OpenAI / Qwen3 / Ollama / Anthropic锛岀嫭绔?API 閰嶇疆 |
| 馃 **鎬濊€冩ā寮忔帶鍒?* | 5 绉嶅弬鏁版牸寮忛€傞厤涓嶅悓妯″瀷璋辩郴锛岃ˉ鍏ㄥ己鍒跺叧闂€佸璇濆彲鑷€夊紑/鍏?|
| 馃摑 **鍔炲叕鏂囨。** | Agent 鐩存帴鍒涘缓 & 璇诲彇 `.docx` / `.xlsx` / `.pdf` |
| 馃攧 **蹇収鍥炴粴** | Agent 姣忔淇敼鑷姩澶囦唤锛岄殢鏃朵竴閿仮澶?|
| 鈿?**Token 娴佸紡** | 瀵硅瘽 SSE 娴佸紡杈撳嚭锛岄瀛楀欢杩熸瀬浣?|
| 馃枼锔?**浣庣増鏈吋瀹?* | 鏈€浣庢敮鎸?VSCode 1.66 / Windows 7 |

## 蹇€熷紑濮?
### 瀹夎

1. 涓嬭浇鏈€鏂?`.vsix` 鏂囦欢锛圼Releases](https://github.com/GitHub鐢ㄦ埛鍚?Cody_for_VScode/releases)锛?2. VSCode 鈫?`Ctrl+Shift+P` 鈫?`Extensions: Install from VSIX...` 鈫?閫夋嫨鏂囦欢
3. 鐐瑰嚮宸︿晶 Cody 鍥炬爣鎵撳紑渚ц竟鏍?鈫?杩涘叆璁剧疆閰嶇疆 API

### 閰嶇疆 API

鎵撳紑璁剧疆闈㈡澘锛堜晶杈规爮 鈿欙笍 鍥炬爣锛夛紝鎸夋爣绛鹃〉閰嶇疆锛?
| 鏍囩 | 閰嶇疆椤?|
|------|--------|
| 馃敆 API | 瀵硅瘽 & 琛ュ叏鍚勮嚜鐨?Base URL 鍜?Key |
| 馃 妯″瀷 | 瀵硅瘽妯″瀷 / 琛ュ叏妯″瀷 / 鎬濊€冨弬鏁版牸寮?/ 鎬濊€冨紑鍏?|
| 鈱笍 琛ュ叏 | inline / dropdown / both |
| 馃 Agent | 鏈€澶ц疆鏁?/ Tokens / Temperature |
| 馃 Skills | 瀵煎叆 & 绠＄悊 Agent 棰嗗煙鐭ヨ瘑 |

### 琛ュ叏妯″紡

| 妯″紡 | 瑙﹀彂鏂瑰紡 | 鎺ュ彈鏂瑰紡 |
|------|----------|----------|
| `inline` | 鎵撳瓧鍚?250ms 鑷姩 | **Tab** |
| `dropdown` | 杈撳叆 鈮? 涓瓧绗?| **Enter**锛堝垪琛ㄩ浣嶅嵆 AI 缁撴灉锛?|
| `both` | 涓よ€呭悓鏃?| Tab / Enter 鍚勫徃鍏惰亴 |

## 椤圭洰缁撴瀯

```
cody-for-vscode/
鈹溾攢鈹€ package.json              # VSCode 鎵╁睍閰嶇疆 & 璐＄尞鐐?鈹溾攢鈹€ tsconfig.json
鈹溾攢鈹€ src/
鈹?  鈹溾攢鈹€ extension.ts          # 鍏ュ彛锛氭敞鍐?Provider + 鍛戒护
鈹?  鈹溾攢鈹€ api/
鈹?  鈹?  鈹斺攢鈹€ openaiClient.ts   # OpenAI 鍏煎 HTTP 瀹㈡埛绔紙娴佸紡 / 闈炴祦寮忥級
鈹?  鈹溾攢鈹€ completion/
鈹?  鈹?  鈹溾攢鈹€ completionProvider.ts  # inline 骞界伒鏂囧瓧琛ュ叏
鈹?  鈹?  鈹斺攢鈹€ dropdownProvider.ts    # dropdown 涓嬫媺鍊欓€夎ˉ鍏?鈹?  鈹溾攢鈹€ chat/
鈹?  鈹?  鈹溾攢鈹€ chatPanel.ts      # Webview 鍚庣閫昏緫
鈹?  鈹?  鈹溾攢鈹€ chat.html         # Webview UI锛堣缃潰鏉?+ 瀵硅瘽 + Skills锛?鈹?  鈹?  鈹斺攢鈹€ chat.js           # Webview 鍓嶇浜や簰
鈹?  鈹溾攢鈹€ agent/
鈹?  鈹?  鈹斺攢鈹€ agentEngine.ts    # Agent 宸ュ叿瀹氫箟 & 鎵ц & Prompt 鐢熸垚
鈹?  鈹溾攢鈹€ skills/
鈹?  鈹?  鈹斺攢鈹€ skillManager.ts   # SKILL 瀵煎叆 / 鍚 / 绉婚櫎 / 鎸佷箙鍖?鈹?  鈹溾攢鈹€ config/
鈹?  鈹?  鈹斺攢鈹€ settings.ts       # VSCode 閰嶇疆璇诲啓
鈹?  鈹斺攢鈹€ commands/
鈹?      鈹斺攢鈹€ explainCommands.ts # 鍛戒护娉ㄥ唽
鈹溾攢鈹€ skills/
鈹?  鈹斺攢鈹€ code-analysis.skill   # 绀轰緥锛氫唬鐮佸垎鏋?Skill
鈹斺攢鈹€ out/                      # 缂栬瘧浜х墿锛坱sc锛?```

## 鎶€鏈爤

| 灞?| 鎶€鏈?|
|---|------|
| 璇█ | TypeScript |
| 杩愯鏃?| Node.js (VSCode Extension Host) |
| API | VSCode Extension API v1.66+ |
| AI 閫氫俊 | Node.js 鍘熺敓 `http`/`https` + SSE 娴佸紡瑙ｆ瀽 |
| 鏂囨。澶勭悊 | `mammoth` / `docx` / `xlsx` / `pdf-parse` |
| 鐘舵€佹寔涔呭寲 | VSCode ExtensionContext.globalState |

## 澶氭ā鍨嬪吋瀹圭煩闃?
| 璋辩郴 | 鎬濊€冨叧闂弬鏁?| 浠ｈ〃妯″瀷 |
|------|-------------|----------|
| MiniMax / OpenAI | `extra_body: { thinking: false }` | MiniMax-M2.5, GPT-4o |
| Qwen3 | `chat_template_kwargs: { enable_thinking: false }` | Qwen3-30B, Qwen3-Coder |
| Ollama | `think: false` | codellama, qwen2.5-coder |
| Anthropic | `extra_body: { thinking: { type: "disabled" } }` | Claude 3.5/4 via 浠ｇ悊 |

## 寮€鍙?
```bash
# 瀹夎渚濊禆
npm install

# 缂栬瘧
npm run compile

# 鎵撳寘
npx vsce package --allow-missing-repository
```

## 璁稿彲璇?
MIT License.

Copyright 漏 2025

---

> **Agent 妯″紡鍐呮牳閫昏緫鍩轰簬 [Cody_for_Windows](https://github.com/GitHub鐢ㄦ埛鍚?Cody_for_Windows)锛屾湰鎻掍欢瀹屽叏閫氳繃 AI 寮€鍙戙€?*
