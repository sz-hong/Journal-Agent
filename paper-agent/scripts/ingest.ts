/**
 * Local bulk ingest: embed the project's PDFs and load them into Vectorize + KV.
 *
 *   npm run ingest            # embed all ../*.pdf, write NDJSON, then wrangler insert
 *   npm run ingest -- --no-run  # only write data/ files, skip wrangler commands
 *
 * Requires OPENAI_API_KEY (from paper-agent/.dev.vars or the environment) and,
 * for the insert step, a created Vectorize index + KV namespace and wrangler auth.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { extractPdfPages } from "../src/pdf";
import { buildVectorRecords } from "../src/ingest-core";
import { embedTexts } from "../src/openai";
import type { Env } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");
const PAPERS_DIR = resolve(PROJECT, ".."); // the Journals folder
const DATA_DIR = join(PROJECT, "data");
const VECTORS_FILE = join(DATA_DIR, "vectors.ndjson");
const KV_FILE = join(DATA_DIR, "papers-kv.json");
const INDEX_NAME = "paper-index";
const EMBED_MODEL = "text-embedding-3-small";

/** Friendly titles (matches the Python ingest); falls back to the file name. */
const PAPER_TITLES: Record<string, string> = {
  "A_Comprehensive_Review_of_Face_Recognition_Techniques_Trends_and_Challenges.pdf":
    "Gururaj et al. (2024) — Comprehensive Review of FR Techniques",
  "A_Systematic_Review_of_Facial_Recognition_Methods_Advancements_Applications_and_Ethical_Dilemmas.pdf":
    "Fola-Rose et al. — Systematic Review: Advancements, Applications, Ethical Dilemmas",
  "laws-13-00035.pdf": "Lynch (2024) — FRT in Policing and Security: Case Studies in Regulation",
  "bioengineering-09-00273.pdf": "Qiang et al. (2022) — FR-Based Applications in Disease Diagnosis",
  "1-s2.0-S2667096824000429-main.pdf": "Nguyen-Tat et al. (2024) — Automating Attendance Management with FR",
  "Zarkasyi_2020_J._Phys.__Conf._Ser._1566_012069.pdf": "Zarkasyi et al. (2020) — Implementation of FR in Society",
};

function readDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = join(PROJECT, ".dev.vars");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main() {
  const noRun = process.argv.includes("--no-run");
  const apiKey = process.env.OPENAI_API_KEY || readDevVars().OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY (set it in paper-agent/.dev.vars or the environment).");
    process.exit(1);
  }
  const env = { OPENAI_API_KEY: apiKey, OPENAI_EMBED_MODEL: EMBED_MODEL } as unknown as Env;

  const pdfs = readdirSync(PAPERS_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (pdfs.length === 0) {
    console.error(`No PDFs found in ${PAPERS_DIR}`);
    process.exit(1);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const ndjsonLines: string[] = [];
  const kvEntries: Array<{ key: string; value: string; metadata: { title: string } }> = [];

  for (const file of pdfs) {
    const title = PAPER_TITLES[file] ?? file.replace(/\.pdf$/i, "");
    const bytes = new Uint8Array(readFileSync(join(PAPERS_DIR, file)));
    const pages = await extractPdfPages(bytes);
    const records = await buildVectorRecords(
      pages,
      { sourceFile: file, title },
      (texts) => embedTexts(env, texts),
    );
    for (const r of records) ndjsonLines.push(JSON.stringify(r));
    kvEntries.push({ key: file, value: title, metadata: { title } });
    console.log(`  ${title}: ${records.length} chunks`);
  }

  writeFileSync(VECTORS_FILE, ndjsonLines.join("\n") + "\n", "utf8");
  writeFileSync(KV_FILE, JSON.stringify(kvEntries, null, 2), "utf8");
  console.log(`\nWrote ${ndjsonLines.length} vectors → ${VECTORS_FILE}`);
  console.log(`Wrote ${kvEntries.length} paper entries → ${KV_FILE}`);

  if (noRun) {
    console.log("\n--no-run: skipping wrangler. To load manually:");
    console.log(`  npx wrangler vectorize insert ${INDEX_NAME} --file data/vectors.ndjson`);
    console.log(`  npx wrangler kv bulk put --binding PAPERS_KV data/papers-kv.json`);
    return;
  }

  console.log("\nInserting into Vectorize…");
  execSync(`npx wrangler vectorize insert ${INDEX_NAME} --file data/vectors.ndjson`, {
    cwd: PROJECT,
    stdio: "inherit",
  });
  console.log("\nWriting paper manifest to KV…");
  execSync(`npx wrangler kv bulk put --binding PAPERS_KV data/papers-kv.json`, {
    cwd: PROJECT,
    stdio: "inherit",
  });
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
