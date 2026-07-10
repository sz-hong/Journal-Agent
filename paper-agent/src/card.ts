import type { Env, PdfPage, PaperCard } from "./types";
import { chat } from "./openai";

/** Character budget per map batch (roughly 3k tokens of paper text). */
const MAP_BATCH_CHARS = 12000;
/** Hard cap on map calls; overflow keeps the head batches plus the final one. */
const MAX_MAP_BATCHES = 8;

const MAP_PROMPT = `你是學術論文閱讀助手，請為以下論文段落撰寫逐段筆記。
- 抽取：研究問題、方法、資料（資料集／樣本）、數據結果、限制
- 逐點條列，繁體中文，專有名詞、模型與資料集名稱保留英文
- 保留關鍵數字與頁碼標記（如 [p.3]）
- 只根據提供的內容撰寫，不得捏造`;

const REDUCE_PROMPT = `你是學術論文閱讀助手，請根據整篇論文的內容或閱讀筆記，輸出一張結構化卡片。
- 只輸出一個 JSON 物件，鍵為 overview, why, how, what, limitations，不得有任何其他文字
- overview：3–5 句概述論文的主題、方法與主要發現
- why：研究問題與其重要性
- how：方法／技術路線，以及使用的資料集或樣本
- what：主要發現，必須包含關鍵數據
- limitations：研究限制與未解問題
- 值為繁體中文字串，專有名詞、模型與資料集名稱保留英文
- 只根據提供的內容撰寫，不得捏造數據或結論`;

/**
 * Pack page texts into batches of at most `limit` characters, each page
 * prefixed with its [p.N] marker. When the paper exceeds MAX_MAP_BATCHES
 * batches, keep the leading batches plus the final one so the conclusion
 * survives truncation.
 */
export function buildBatches(pages: PdfPage[], limit = MAP_BATCH_CHARS): string[] {
  const batches: string[] = [];
  let current = "";
  for (const p of pages) {
    const text = p.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    let piece = `[p.${p.page}] ${text}`;
    if (current && current.length + 1 + piece.length > limit) {
      batches.push(current);
      current = "";
    }
    // A single page longer than the limit is split at the limit boundary.
    while (piece.length > limit) {
      batches.push(piece.slice(0, limit));
      piece = piece.slice(limit);
    }
    if (!piece) continue;
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) batches.push(current);
  if (batches.length > MAX_MAP_BATCHES) {
    return [...batches.slice(0, MAX_MAP_BATCHES - 1), batches[batches.length - 1]];
  }
  return batches;
}

/** Validate an unknown value as a PaperCard (field-wise, no deps). */
export function parseCard(v: unknown): PaperCard | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const fields = ["overview", "why", "how", "what", "limitations"] as const;
  for (const f of fields) {
    if (typeof o[f] !== "string" || (o[f] as string).trim().length === 0) return undefined;
  }
  return {
    overview: (o.overview as string).trim(),
    why: (o.why as string).trim(),
    how: (o.how as string).trim(),
    what: (o.what as string).trim(),
    limitations: (o.limitations as string).trim(),
    generatedAt: typeof o.generatedAt === "number" ? o.generatedAt : Date.now(),
  };
}

/**
 * Map-reduce the full paper into a structured reading card. Short papers
 * (one batch) skip the map phase and reduce over the raw text directly.
 * Best-effort like summarizePaper: returns null on any failure so ingest
 * never breaks on this step.
 */
export async function generatePaperCard(
  env: Env,
  title: string,
  pages: PdfPage[],
): Promise<PaperCard | null> {
  try {
    const batches = buildBatches(pages);
    if (batches.length === 0) return null;

    let notes: string;
    if (batches.length === 1) {
      notes = batches[0];
    } else {
      const mapped = await Promise.all(
        batches.map((batch, i) =>
          chat(env, [
            { role: "system", content: MAP_PROMPT },
            {
              role: "user",
              content: `論文標題：${title}\n\n段落內容（第 ${i + 1}/${batches.length} 批）：\n${batch}`,
            },
          ]),
        ),
      );
      notes = mapped.join("\n\n");
    }

    const raw = await chat(env, [
      { role: "system", content: REDUCE_PROMPT },
      { role: "user", content: `論文標題：${title}\n\n論文內容或筆記：\n${notes}` },
    ]);
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    return parseCard(JSON.parse(jsonText)) ?? null;
  } catch {
    return null;
  }
}
