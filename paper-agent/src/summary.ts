import type { Env, PdfPage } from "./types";
import { chat } from "./openai";

/** Cap on how much leading paper text is fed to the summarizer. */
const EXCERPT_LIMIT = 6000;

const SUMMARY_PROMPT = `你是學術論文摘要助手。根據提供的論文開頭內容，用繁體中文寫一段摘要：
- 先用 3–5 句話概述論文的主題、方法與主要發現
- 接著列出 3 條重點（每條一行，用「1. 2. 3.」編號）
- 只根據提供的內容撰寫，不得捏造數據或結論
- 專有名詞與模型名稱保留英文原文
- 純文字輸出，不使用 Markdown 語法`;

/**
 * Generate a Traditional-Chinese summary from the paper's leading pages.
 * Best-effort: returns "" on any failure so ingest never breaks on this step.
 */
export async function summarizePaper(env: Env, title: string, pages: PdfPage[]): Promise<string> {
  const excerpt = pages
    .map((p) => p.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .slice(0, EXCERPT_LIMIT);
  if (excerpt.trim().length === 0) return "";

  try {
    const summary = await chat(env, [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: `論文標題：${title}\n\n論文開頭內容：\n${excerpt}` },
    ]);
    return summary.trim();
  } catch {
    return "";
  }
}
