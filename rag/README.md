# 論文 RAG 資料庫

用 6 篇人臉辨識論文建立的本地語意檢索資料庫。全本地、免 API 金鑰、零成本。

## 架構

| 元件 | 用途 |
|------|------|
| **pypdf** | 抽取 PDF 文字 |
| **ChromaDB** | 本地向量資料庫（持久化於 `chroma_db/`） |
| **all-MiniLM-L6-v2**（onnxruntime） | 本地嵌入模型，首次執行自動下載（約 80MB） |
| Python 虛擬環境 | `C:\Users\thoma\face_rag_env`（Python 3.13） |

目前索引：6 篇論文 → **528 個文字塊**。

## 使用方式

所有指令用虛擬環境的 Python 執行。為方便，以下用 `$PY` 代表：
`C:\Users\thoma\face_rag_env\Scripts\python.exe`

### 1. 建立 / 重建索引
新增或修改 PDF 後執行（會清空並重建）：
```powershell
& C:\Users\thoma\face_rag_env\Scripts\python.exe ingest.py
```

### 2. 查詢（單次）
```powershell
& C:\Users\thoma\face_rag_env\Scripts\python.exe query.py "Cushing 症候群的辨識準確度"
```

### 3. 查詢（互動模式，可連續提問）
```powershell
& C:\Users\thoma\face_rag_env\Scripts\python.exe query.py
```
輸入 `exit` 離開。

### 調整回傳段落數
用 `-k`（預設 5）：
```powershell
& C:\Users\thoma\face_rag_env\Scripts\python.exe query.py -k 8 "EU AI Act 對即時人臉辨識的規範"
```

## 說明

- **相似度分數**：0~1，越高越相關（採 cosine 相似度）。中文問題可查到英文內容，但英文問題通常分數更高——嵌入模型以英文為主，**用英文關鍵字查詢效果最佳**。
- **出處**：每筆結果標註論文標題與頁碼，方便回頭核對原文。
- 本工具只做**檢索**（找出相關段落），不自動生成答案。若要進一步「問答生成」，可把檢索到的段落貼給 Claude/ChatGPT，或之後接上 LLM API。

## 調整參數

編輯 `ingest.py` 頂部：
- `CHUNK_SIZE`（預設 1000）：每塊字元數
- `CHUNK_OVERLAP`（預設 200）：相鄰塊重疊字元數

改完需重跑 `ingest.py`。

## 檔案

```
rag/
├── ingest.py     # 建立/重建向量索引
├── query.py      # 查詢
├── README.md     # 本說明
└── chroma_db/    # 向量資料庫（自動產生，勿手動編輯）
```
