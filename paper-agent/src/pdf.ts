import { extractText, getDocumentProxy } from "unpdf";
import type { PdfPage } from "./types";

/**
 * Extract per-page text from a PDF using unpdf (serverless/Workers-friendly).
 * Returns one entry per page with a 1-indexed page number.
 */
export async function extractPdfPages(data: ArrayBuffer | Uint8Array): Promise<PdfPage[]> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((t, i) => ({ page: i + 1, text: t ?? "" }));
}
