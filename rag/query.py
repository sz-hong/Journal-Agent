"""
查詢論文 RAG 向量資料庫。

輸入問題，回傳最相關的論文段落與出處（論文標題 + 頁碼）。
本腳本只做「語意檢索」，不呼叫 LLM，零成本、全本地。

用法：
    # 直接帶問題
    C:\\Users\\thoma\\face_rag_env\\Scripts\\python.exe query.py "什麼是 Cushing 症候群的辨識準確度？"

    # 指定回傳筆數
    C:\\Users\\thoma\\face_rag_env\\Scripts\\python.exe query.py -k 8 "EU AI Act 對即時人臉辨識的規範"

    # 不帶問題則進入互動模式（可連續提問，輸入 exit 離開）
    C:\\Users\\thoma\\face_rag_env\\Scripts\\python.exe query.py
"""

import sys
import io
import argparse
import pathlib

import chromadb
from chromadb.utils import embedding_functions

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

RAG_DIR = pathlib.Path(__file__).resolve().parent
DB_DIR = RAG_DIR / "chroma_db"
COLLECTION_NAME = "papers"


def get_collection():
    client = chromadb.PersistentClient(path=str(DB_DIR))
    embed_fn = embedding_functions.DefaultEmbeddingFunction()
    return client.get_collection(name=COLLECTION_NAME, embedding_function=embed_fn)


def search(collection, question, k=5):
    res = collection.query(query_texts=[question], n_results=k)
    docs = res["documents"][0]
    metas = res["metadatas"][0]
    dists = res["distances"][0]
    print(f"\n問題：{question}")
    print("=" * 70)
    for rank, (doc, meta, dist) in enumerate(zip(docs, metas, dists), start=1):
        similarity = 1 - dist  # cosine distance -> similarity
        print(f"\n[{rank}] 相似度 {similarity:.3f} | {meta['title']} (p.{meta['page']})")
        print("-" * 70)
        snippet = doc.strip()
        if len(snippet) > 600:
            snippet = snippet[:600] + " …"
        print(snippet)
    print("\n" + "=" * 70)


def main():
    parser = argparse.ArgumentParser(description="查詢論文 RAG 資料庫")
    parser.add_argument("question", nargs="*", help="要查詢的問題")
    parser.add_argument("-k", type=int, default=5, help="回傳最相關的段落數 (預設 5)")
    args = parser.parse_args()

    try:
        collection = get_collection()
    except Exception as e:
        print("無法開啟索引，請先執行 ingest.py 建立資料庫。")
        print(f"錯誤：{e}")
        return

    if args.question:
        search(collection, " ".join(args.question), k=args.k)
    else:
        print("互動查詢模式（輸入 exit / quit 離開）")
        while True:
            try:
                q = input("\n> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if q.lower() in {"exit", "quit", "q", ""}:
                break
            search(collection, q, k=args.k)


if __name__ == "__main__":
    main()
