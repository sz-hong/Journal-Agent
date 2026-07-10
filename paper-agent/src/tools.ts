import type { Env, PaperManifest, RetrievedContext, ToolDefinition } from "./types";
import { embedQuery } from "./openai";
import { queryContexts, filterBySource } from "./retrieval";
import { parseManifest } from "./manifest";

/** topK for an unscoped search. */
const SEARCH_K = 8;
/** Larger topK when scoping to one paper, to offset the Worker-side filter. */
const SEARCH_K_SCOPED = 12;
/** A query above this CJK ratio is bounced back for an English rewrite. */
const MAX_CJK_RATIO = 0.3;

/** What a tool hands back: text for the model, plus contexts for citations. */
export interface ToolResult {
  content: string;
  contexts?: RetrievedContext[];
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_papers",
      description:
        "List every paper in this session with its file name, title, and one-line overview. " +
        "Call this first when comparing papers or when unsure which papers exist.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_paper_card",
      description:
        "Get one paper's structured reading card: research question (why), method & data (how), " +
        "main findings with key numbers (what), and limitations. Use it as the backbone for " +
        "single-paper interpretation and for dimension-by-dimension comparison.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "The paper's file name exactly as returned by list_papers.",
          },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_passages",
      description:
        "Vector-search the papers' full text for passages relevant to a query. Returns numbered " +
        "passages with title and page so they can be cited as (Title, p.PAGE).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Must be 3-8 English keywords; the papers are in English, so translate Chinese " +
              "concepts into English technical terms first.",
          },
          file: {
            type: "string",
            description: "Optional: restrict the search to this paper (file name from list_papers).",
          },
        },
        required: ["query"],
      },
    },
  },
];

const paperPrefix = (sid: string) => `s:${sid}:paper:`;

/** Load every paper manifest in the session (papers per session stay small). */
async function listManifests(
  env: Env,
  sid: string,
): Promise<Array<{ file: string; manifest: PaperManifest }>> {
  const prefix = paperPrefix(sid);
  const list = await env.PAPERS_KV.list({ prefix });
  return Promise.all(
    list.keys.map(async (k) => {
      const file = k.name.slice(prefix.length);
      return { file, manifest: parseManifest(await env.PAPERS_KV.get(k.name), file) };
    }),
  );
}

/** Share of CJK characters among the query's non-space characters. */
function cjkRatio(s: string): number {
  const chars = [...s].filter((ch) => /\S/.test(ch));
  if (chars.length === 0) return 0;
  const cjk = chars.filter((ch) => /[぀-ヿ㐀-鿿豈-﫿]/.test(ch)).length;
  return cjk / chars.length;
}

function formatPassages(contexts: RetrievedContext[]): string {
  if (contexts.length === 0) return "no relevant passages found";
  return contexts.map((c, i) => `[${i + 1}] ${c.title} (p.${c.page})\n${c.text}`).join("\n\n");
}

/**
 * Execute one model-requested tool. Never throws: bad input comes back as an
 * error string in `content` so the model can correct itself and retry.
 */
export async function executeTool(
  env: Env,
  sid: string,
  name: string,
  rawArgs: string,
): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { content: "error: tool arguments were not valid JSON — retry with corrected arguments" };
  }

  switch (name) {
    case "list_papers": {
      const papers = await listManifests(env, sid);
      if (papers.length === 0) return { content: "（此 session 尚未上傳任何論文）" };
      return {
        content: papers
          .map(({ file, manifest }) => {
            const overview = manifest.card?.overview || manifest.summary || "（無摘要）";
            return `- file: ${file}\n  title: ${manifest.title}\n  overview: ${overview}`;
          })
          .join("\n"),
      };
    }

    case "get_paper_card": {
      const file = typeof args.file === "string" ? args.file : "";
      const papers = await listManifests(env, sid);
      const hit = papers.find((p) => p.file === file);
      if (!hit) {
        const available = papers.map((p) => p.file).join(", ") || "(none)";
        return { content: `error: unknown file "${file}" — available papers: ${available}` };
      }
      const { manifest } = hit;
      if (!manifest.card) {
        return {
          content:
            `《${manifest.title}》尚無結構化卡片（可在論文庫按「重新產生卡片」補產）。` +
            `簡短摘要：${manifest.summary || "（無摘要）"}`,
        };
      }
      const card = manifest.card;
      return {
        content:
          `《${manifest.title}》(file: ${file})\n` +
          `OVERVIEW: ${card.overview}\n` +
          `WHY（研究問題與重要性）: ${card.why}\n` +
          `HOW（方法與資料）: ${card.how}\n` +
          `WHAT（主要發現與數據）: ${card.what}\n` +
          `LIMITATIONS（限制與未解問題）: ${card.limitations}`,
      };
    }

    case "search_passages": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { content: "error: a non-empty 'query' string is required" };
      if (cjkRatio(query) > MAX_CJK_RATIO) {
        return {
          content:
            "error: query must be English keywords (the papers are in English) — " +
            "rewrite the query in English and retry",
        };
      }
      const file = typeof args.file === "string" && args.file ? args.file : undefined;
      if (file) {
        const papers = await listManifests(env, sid);
        if (!papers.some((p) => p.file === file)) {
          const available = papers.map((p) => p.file).join(", ") || "(none)";
          return { content: `error: unknown file "${file}" — available papers: ${available}` };
        }
      }
      const vec = await embedQuery(env, query);
      let contexts = await queryContexts(env, vec, file ? SEARCH_K_SCOPED : SEARCH_K, sid);
      if (file) contexts = filterBySource(contexts, file);
      return { content: formatPassages(contexts), contexts };
    }

    default:
      return { content: `error: unknown tool "${name}"` };
  }
}
