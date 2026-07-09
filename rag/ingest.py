"""
建立論文 RAG 向量資料庫 (ingest)。

讀取 Journals 資料夾中所有 PDF，逐頁抽取文字、切塊，
以 ChromaDB 內建的本地嵌入模型 (all-MiniLM-L6-v2, onnxruntime) 建立索引。
索引持久化存於 rag/chroma_db/，之後用 query.py 查詢。

用法：
    C:\\Users\\thoma\\face_rag_env\\Scripts\\python.exe ingest.py
"""

import sys
import io
import pathlib

import chromadb
from chromadb.utils import embedding_functions
from pypdf import PdfReader

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# --- 路徑設定 ---
RAG_DIR = pathlib.Path(__file__).resolve().parent          # rag/
PAPERS_DIR = RAG_DIR.parent                                # Journals/
DB_DIR = RAG_DIR / "chroma_db"
COLLECTION_NAME = "papers"

# --- 切塊參數 ---
CHUNK_SIZE = 1000     # 每塊約略字元數
CHUNK_OVERLAP = 200   # 相鄰塊重疊字元數，避免切斷語意

# 檔名 -> 友善論文標題（用於顯示出處）
PAPER_TITLES = {
    "A_Comprehensive_Review_of_Face_Recognition_Techniques_Trends_and_Challenges.pdf":
        "Gururaj et al. (2024) — Comprehensive Review of FR Techniques",
    "A_Systematic_Review_of_Facial_Recognition_Methods_Advancements_Applications_and_Ethical_Dilemmas.pdf":
        "Fola-Rose et al. — Systematic Review: Advancements, Applications, Ethical Dilemmas",
    "laws-13-00035.pdf":
        "Lynch (2024) — FRT in Policing and Security: Case Studies in Regulation",
    "bioengineering-09-00273.pdf":
        "Qiang et al. (2022) — FR-Based Applications in Disease Diagnosis",
    "1-s2.0-S2667096824000429-main.pdf":
        "Nguyen-Tat et al. (2024) — Automating Attendance Management with FR",
    "Zarkasyi_2020_J._Phys.__Conf._Ser._1566_012069.pdf":
        "Zarkasyi et al. (2020) — Implementation of FR in Society",
}


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """把一段文字切成有重疊的小塊。"""
    text = " ".join(text.split())  # 正規化空白
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + size
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - overlap
    return chunks


def main():
    pdf_files = sorted(PAPERS_DIR.glob("*.pdf"))
    if not pdf_files:
        print(f"找不到 PDF：{PAPERS_DIR}")
        return

    client = chromadb.PersistentClient(path=str(DB_DIR))

    # 每次重建，確保乾淨（論文數量少，成本低）
    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass

    embed_fn = embedding_functions.DefaultEmbeddingFunction()  # 本地 all-MiniLM-L6-v2
    collection = client.create_collection(
        name=COLLECTION_NAME,
        embedding_function=embed_fn,
        metadata={"hnsw:space": "cosine"},
    )

    ids, documents, metadatas = [], [], []
    for pdf_path in pdf_files:
        fname = pdf_path.name
        title = PAPER_TITLES.get(fname, fname)
        reader = PdfReader(str(pdf_path))
        n_chunks = 0
        for page_num, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            for ci, chunk in enumerate(chunk_text(text)):
                if len(chunk.strip()) < 50:   # 跳過過短片段
                    continue
                ids.append(f"{fname}::p{page_num}::c{ci}")
                documents.append(chunk)
                metadatas.append({
                    "source_file": fname,
                    "title": title,
                    "page": page_num,
                })
                n_chunks += 1
        print(f"  {title}: {n_chunks} chunks (from {len(reader.pages)} pages)")

    print(f"\n共 {len(documents)} 個文字塊，正在建立嵌入與索引…")
    # 分批加入，避免單次過大
    BATCH = 100
    for i in range(0, len(documents), BATCH):
        collection.add(
            ids=ids[i:i + BATCH],
            documents=documents[i:i + BATCH],
            metadatas=metadatas[i:i + BATCH],
        )
    print(f"完成！索引已存於：{DB_DIR}")
    print(f"集合 '{COLLECTION_NAME}' 共 {collection.count()} 筆。")


if __name__ == "__main__":
    main()
