# 人臉辨識論文整理

本文件分別整理 6 篇人臉辨識相關論文，每篇各自獨立成篇，最後附上綜合比較表。

## 目錄
1. [A Comprehensive Review of Face Recognition Techniques, Trends, and Challenges](#論文一) — 技術方法綜述
2. [A Systematic Review of Facial Recognition Methods: Advancements, Applications, and Ethical Dilemmas](#論文二) — 應用與倫理
3. [Facial Recognition Technology in Policing and Security—Case Studies in Regulation](#論文三) — 執法監控與法規
4. [Review on Facial-Recognition-Based Applications in Disease Diagnosis](#論文四) — 醫療疾病診斷
5. [Automating Attendance Management using Computer Vision and Facial Recognition](#論文五) — 考勤系統實作
6. [Literature Review: Implementation of Facial Recognition in Society](#論文六) — 社會應用綜述

---
---

<a id="論文一"></a>
# 論文一：A Comprehensive Review of Face Recognition Techniques, Trends, and Challenges

**作者**：H. L. Gururaj, B. C. Soundarya, S. Priya, J. Shreyas, F. Flammini
**出處**：IEEE Access, vol. 12, 2024. DOI: 10.1109/ACCESS.2024.3424933
**類型**：技術綜述（Survey）— 偏向技術方法與分類

## 摘要重點
- 人臉辨識 (Face Recognition, FR) 是依據面部特徵識別與驗證身份的技術
- 主要貢獻：全面回顧 SOTA 技術，並提出方法**分類法 (Taxonomy)**，涵蓋外觀到混合方法
- 分析影像式與影片式 FR，並整理資料集趨勢

## 一、緒論
- 傳統識別方式（身分證、駕照）易遭竊取偽造；生物辨識具內在唯一性
- 兩大任務：**人臉識別**（1:N 找身份）、**人臉驗證**（1:1 比對是否同一人）
- 依維度分 **2D / 3D**；多數研究偏好 2D（易取得、低成本、易實作）

## 二、FR 系統流程
| 步驟 | 方法 |
|------|------|
| **人臉偵測** | Viola-Jones (Haar-like)、HOG、PCA、膚色資訊 |
| **特徵擷取** | 統計法（SIFT/Gabor/LPQ/LDA/ICA）、特徵模板法、結構匹配法（彈性圖匹配/LBP） |
| **人臉辨識** | 分類器 CNN/KNN/ANN/SVM/RandomForest；濾波 Gaussian/Wiener |

## 三、人臉辨識分類法
### 3.1 影像式 (Image-Based)
- **外觀法—線性**：PCA/Eigenface（無監督降維）、LDA/Fisherface（監督式，最大化類間差異）
- **外觀法—非線性**：KPCA、KDA/KFD、FLD/Fisherfaces、LLE、Laplacian Eigenmaps、Isomap
- **模型法（地標式）**：DLFR（改良 SIFT+基因演算法+SVM）、PDM（標記點描述臉形）
- **混合法**：Gabor+2D-LDA+KNN、霧運算FR（96.77%）、MS-CFB、DCNNs+臉部動態、DUM、BERL、3D R3DM
- **深度學習**：CNN 為主流；VGGFace、FaceNet

### 3.2 影片式 (Video-Based)
- **集合式**：影格視為獨立樣本，分「匹配前融合」與「匹配後融合」；MMD 流形距離
- **序列式**：考慮影格時序關係

## 四、資料集與評估指標
- **資料集**：CASIA WebFace、VGGFace、UMDFaces、MS-Celeb-1M、Yale A/B、AR、Gavab（3D）、TinyFace（低解析度）
- **評估指標**：FMR/FAR、FNMR/FRR、Accuracy、GAR/TAR、EER、ROC

## 五、挑戰與未來方向
- **技術挑戰**：姿態、光照、表情、遮擋、老化、大規模資料庫、即時效能
- **影片式開放問題**：多臉擴展性、非受控變化劇烈、可變長度編碼困難
- **未來**：生成式 AI 用於 3D 模型生成、健全的隱私與倫理規範

---
---

<a id="論文二"></a>
# 論文二：A Systematic Review of Facial Recognition Methods: Advancements, Applications, and Ethical Dilemmas

**作者**：Asante Fola-Rose, Keshawn Bryant, Enoch Solomon（Virginia State University）, Abraham Woubie（Silo AI）
**類型**：系統性綜述 — 偏向應用、倫理與社會影響

## 摘要重點
- 深入分析 FR 系統的**進展、應用與倫理困境**
- 強調隱私侵犯、偏見、歧視、普遍監控等爭議
- 探討 AI 生成人臉（深偽 Deepfake）帶來的新挑戰，呼籲全面法規

## 一、方法與技術
| 模型 | 訓練資料 | 效能 |
|------|---------|------|
| VGGFace | 260 萬張 / 2,622 人 | LFW 97.27% |
| FaceNet | 2 億張 / 800 萬人 | LFW 99.63%、YTF 95.12% |
| 3D FR（Azure Kinect） | — | 控制環境 98.3% |

- **函式庫**：OpenCV、Dlib、TensorFlow
- **深度學習架構**：
  - **CNN**：靜態影像 FR 主流
  - **RNN**：序列/影片
  - **GAN**：資料增強、影像增強
  - **Siamese Network**：人臉驗證（共享權重雙網路）
  - **Capsule Network**：保留空間階層與姿態，較 CNN 提升 2-3%

## 二、效益與優勢
- 面部特徵唯一且不可轉讓 → 裝置安全（手機解鎖）
- 尋找失蹤人口、機場安檢（生物護照）、英國用於防治賭博成癮

## 三、倫理困境
- 缺乏透明度與同意、大規模監控、種族偏見與歧視、資料外洩、誤判（執法冤案）

## 四、法規與監管（美國）
- **各州**：伊利諾州（允許個人提告，最前端）、紐約市（2017 起警方使用）
- **聯邦**：無專法，僅拼湊式立法（伊利諾、華盛頓、德州）

## 五、AI 生成人臉與深偽威脅
- **案例**：財務人員被深偽 CFO 詐騙，轉帳 **2,500 萬美元**
- 現有偵測方法不足（某研究僅 36.79%）
- 需開發專門的 AI 深偽偵測工具（尤其金融領域）

---
---

<a id="論文三"></a>
# 論文三：Facial Recognition Technology in Policing and Security—Case Studies in Regulation

**作者**：Nessa Lynch（University College Cork / Victoria University of Wellington）
**出處**：Laws, vol. 13, no. 3, art. 35, 2024. DOI: 10.3390/laws13030035
**類型**：法律/政策論文 — 聚焦執法與安全場景的 FR 監管

## 摘要重點
- 技術驅動的國家監控快速演進，可即時遠端追蹤人與車、彙整大量移動與關係資料
- FRT 影響隱私、言論自由、集會自由等基本權，但也能偵防重大犯罪、維護公共安全
- 本文透過**三個當代監管案例**分析 FRT 監管的挑戰

## 一、FRT 的定義與用途
- FRT 分析由臉部影像生成的電腦模板，與既有影像比對
- 三大用途：**驗證 (Verification)、識別 (Identification)、分類 (Categorisation)**
- 臉部影像是生物特徵（如同指紋、虹膜、聲紋、DNA），屬高度敏感個資
- 用途光譜：從高風險（即時自動 FRT、情緒辨識）到低風險（線上護照申請、機場自動通關、社群標註）

## 二、分類與情緒辨識
- FRT 可從臉部推斷年齡、性別、族裔（甚至被質疑推斷性別認同/性向）
- **情緒辨識 (Emotion Recognition)**：宣稱可掃描臉部偵測情緒，吸引行銷/顧客行為產業

## 三、對人權的影響
- **隱私權**：即時遠端生物識別高度侵入，產生「寒蟬效應」；公共空間隱私是演進中的法律議題
  - Glukhin v. Russia (2023, ECHR)：即使在公共場合，個人與他人互動的區域仍可能屬「私人生活」範疇
- **免於歧視權**：對某些族群準確度較低，可能造成歧視性誤判
- **言論自由權**：
  - R (Bridges) v South Wales Police (2019/2020)：上訴法院認定警方使用即時 FRT 的裁量權過大，影響隱私並可能侵害集會抗議自由
  - Glukhin v. Russia：俄羅斯公民和平抗議後被 FRT 識別逮捕

## 四、三個監管案例研究
1. **自我監管 (Self-Regulation)**：
   - 原則性宣言（如紐西蘭 Algorithm Charter，強調透明度與「human in the loop」）
   - 缺點：不具強制力，受影響者無申訴管道；領導層態度可任意改變（紐西蘭警方曾承諾暫停即時 FRT）
2. **歐盟法律 (EU AI Act)**：
   - 全球首個 AI 立法與監管框架，2024 年 5 月底通過，兩年內漸進實施
   - 具域外效力（如同 GDPR 成為全球標準）
   - 生物驗證（解鎖裝置、存取服務）風險較低；即時遠端生物識別被視為高風險、涉及大規模監控
   - 120 個倡議團體曾主張全面禁止即時 FRT
   - **漏洞**：軍事、國防、國安用途完全排除在規範外，但國安與執法的界線模糊
3. **國家特定立法**：如愛爾蘭的 FRT 草案

## 五、結論
- FRT 監管可分為三類：自我監管、跨國廣泛監管、國家特定立法
- 核心難題：如何妥善定義各方利益（個人權利 vs. 集體安全）
- EU AI Act 是建立健全規範的最佳機會，但仍有排除條款等挑戰

---
---

<a id="論文四"></a>
# 論文四：Review on Facial-Recognition-Based Applications in Disease Diagnosis

**作者**：Jiaqi Qiang, Danning Wu, Hanze Du, Huijuan Zhu, Shi Chen, Hui Pan（北京協和醫院 / 中國醫學科學院）
**出處**：Bioengineering, vol. 9, no. 7, art. 273, 2022. DOI: 10.3390/bioengineering9070273
**類型**：醫學綜述 — FR 於疾病診斷的應用（首篇此主題綜述）

## 摘要重點
- 疾病不僅有內部結構功能異常，也有臉部特徵與外觀畸形
- 特定臉部表型 (facial phenotype) 是潛在診斷標記，尤其是內分泌代謝症候群、遺傳疾病、顏面神經肌肉疾病
- 自 2013 年起相關發表呈指數成長；FR 加速篩檢，實現更早治療

## 一、FR 疾病診斷流程
- 收集患者與對照組（年齡/性別配對）影像 → 偵測人臉 → 擷取臉部表型（知識/統計/深度學習）→ 與資料庫比對相似度 → 分類為患者或健康對照

## 二、臉部分析演算法
| 類別 | 演算法 |
|------|--------|
| **外觀式 (Appearance-based)** | PCA、Eigenface、Kernel PCA、2D-IPCA、LDA、DCV、ICA、IPCA-ICA、SVM |
| **特徵式 (Feature-based)** | 幾何特徵、LBP、EBGM、HoG、EBG、HMM（準確度較高，但需先驗知識選特徵） |
| **深度學習** | PDBNN、RBF（小資料集佳）、CNN（主流）、3D-CNN（多幀動作）、LSTM（結合傳統法） |

- **成熟軟體**：Face++、Face2Gene、OpenFace 2.0、Auto-eFACE、Emotrics

## 三、臨床應用（依疾病類型）
### 3.1 內分泌代謝疾病
- **肢端肥大症 (Acromegaly)**：Kong et al. 敏感度/特異度均 96%；Wei et al. AUC 0.9556、準確度 94.79%
- **庫欣氏症候群 (Cushing's, "moon face")**：Kosilek et al. 91.7%（BMI 配對後降至 61-67%）；Wei et al. AUC 0.9647、95.93%

### 3.2 遺傳與染色體異常
- **透納氏症 (TS)**：敏感度 96.7%、特異度 97.0%
- **框架/工具**：FDNA（Bayesian + LBP）、DeepGestalt、Face2Gene（智慧型手機 app）、DCNN（先天性腎上腺增生）
- 八種遺傳病中，除一項外準確度/AUC 皆 >90%

### 3.3 神經退化性疾病
| 疾病 | 資料 | 方法 | 效能 |
|------|------|------|------|
| 帕金森 PD | 影片 | OpenFace 2.0 + SVM | 準確度 95.6% |
| 帕金森 PD | 影片 | Face++ + tremor + LSTM | Precision 86% |
| 阿茲海默 AD | 影像 | Xception + Adam | 準確度 94% |
| 肌萎縮側索硬化 ALS | 影片 | AAM/CLM/ERT/SDM/FAN | 準確度 88.9% |

### 3.4 其他
- **慢性疲勞症候群 (CFS)**：Gabor 小波 + AdaBoost，準確度約 88-89%

## 四、優於傳統方法之處
- **與專家一致**：媲美 House-Brackmann 顏面神經分級、MMSE 等量表
- **全面且資訊豐富**：Face2Gene 輸出 30 種可能遺傳病排名（top 10 準確率 91%）；3D 技術量化表型
- **NHGRI/NIH**：開發 DiGeorge 症候群（22q11.2 缺失）辨識，各族群敏感度/特異度 >96.6%

## 五、挑戰與展望
- **影響準確度因素**：老化、姿態、遮擋、光照、表情；族裔/性別無顯著影響（Pantel et al.）
- **理論**：Facial Recognition Intensity (FRI)、Object's Complexity Theory (OCT)
- **新技術整合**：3D 攝影（含深度、減少形變）、3D-CNN、醫學教育
- **從研究到產品**：FDA 已核准部分 AI 影像判讀演算法；重點在消除偏見與真實場景驗證
- **隱私與安全**：臉部屬敏感個資，NHGRI 要求簽署同意書；需更多法規（安全、隱私、自主、民主問責）

---
---

<a id="論文五"></a>
# 論文五：Automating Attendance Management in Human Resources — A Design Science Approach using Computer Vision and Facial Recognition

**作者**：Bao-Thien Nguyen-Tat, Minh-Quoc Bui, Vuong M. Ngo（越南資訊科技大學 / 胡志明市開放大學）
**出處**：Int. J. of Information Management Data Insights, vol. 4, art. 100253, 2024
**類型**：系統實作論文（Design Science）— 嵌入式人臉辨識考勤系統

## 摘要重點
- **Haar Cascade** 是低成本、易用的機器學習物件偵測演算法
- 不像深度學習需大量資源，僅用邊緣偵測與 Haar 特徵等簡單影像處理
- 結合 Haar Cascade + OpenCV2 於嵌入式電腦 **NVIDIA Jetson Nano** 進行考勤追蹤
- 目標：取代人工/指紋/刷卡考勤，減少人為介入與錯誤

## 一、系統目標與貢獻
- 用相機擷取臉部，與預註冊資料庫比對，秒級識別身份
- 四項貢獻：
  1. 可部署於多場景的可靠高效考勤系統 (FRAMS)
  2. 展示 Haar Cascade + OpenCV2 的高效、對光照/姿態強健、低運算需求
  3. 展示 Jetson Nano 節能且低成本
  4. 推進 FR 於考勤管理的實務應用

## 二、方法論與理論
- **DSRM（設計科學研究方法）** + Iivari (2007) 的資訊系統典範分析
- **Haar Cascade 理論**（Viola-Jones 2001）：
  - 弱分類器基於 Haar 特徵的閾值函數，經 AdaBoost 選出最佳特徵
  - **級聯分類器 (Cascade of Classifiers)**：38 個階段、逾 6000 個特徵；非人臉區域及早剔除，平均每個子視窗僅評估約 10 個特徵

## 三、系統開發
- **硬體**：NVIDIA Jetson Nano + Pan-Tilt Raspberry Pi Camera
- **軟體**：Python + OpenCV2 + Visual Studio Code；imutils
- **流程**：載入臉部編碼 → Haar Cascade 偵測 → 即時視訊串流擷取影格 → 辨識
- **訓練**：LBPH（Local Binary Patterns Histograms）產生訓練模型；128 維嵌入存為 YAML
- 隱私設計：使用者同意、本地端處理（減少網路傳輸）、資料保留政策、即時通知

## 四、實驗結果
### 4.1 辨識準確度（Jetson Nano）
| 條件 | 30 張/人 | 500 張/人 |
|------|---------|-----------|
| 正常光照 | 79% | 93% |
| 低光照 | 失敗 | 88% |
| 戴口罩+正常光照 | 失敗 | 75% |
| 戴口罩+低光照 | 失敗 | 56% |
- 平均信心水準約 85%

### 4.2 效能比較（Jetson Nano vs. Raspberry Pi 4）
| 指標 | Jetson Nano | Raspberry Pi 4 |
|------|-------------|----------------|
| 訓練時間（30 張/人） | 3,354 秒 | 16,695 秒 |
| 訓練時間（500 張/人） | 15,603 秒 | 43,201 秒 |
| FPS（30 張/人） | 20 FPS | 較低 |
| CPU 使用率 | >70% | >70% |
| RAM | 2.4 GB | 2.4 GB |
- Jetson Nano 運算效率明顯優於 Raspberry Pi 4

## 五、意涵
- **學術**：結合技術效率與組織行為的跨領域研究
- **實務**：教育（減輕行政負擔）、職場（提升生產力）、大型活動（來賓管理與安全）

---
---

<a id="論文六"></a>
# 論文六：Literature Review — Implementation of Facial Recognition in Society

**作者**：M I Zarkasyi, M R Hidayatullah, E M Zamzami（Universitas Sumatera Utara, 印尼）
**出處**：J. Phys.: Conf. Ser., vol. 1566, art. 012069, 2020 (ICCAI 2019). DOI: 10.1088/1742-6596/1566/1/012069
**類型**：社會導向文獻回顧 — FR 在社會中的實際應用與影響

## 摘要重點
- FR 是影像分析最成功的應用之一，近年受高度關注
- FRT 結合生物辨識（將身份綁定於身體特徵）與視覺監控功能
- 進行**社會政治分析**，橋接技術與社會科學文獻
- 臉部與擁有者不可分離（除同卵雙胞胎外），且不可轉讓

## 一、緒論
- 多數 FR 研究聚焦演算法效能，本文改從社會實作角度切入
- 結構：背景動機 → 可用軟硬體技術 → 對現代社會的正負面影響 → 結論與建議

## 二、FR 技術的社會應用
- **醫療**：2002 FRVT 可連結同卵雙胞胎臉孔
- **智慧型手機**：Google Pixel 4 支援動態條件下的臉部辨識（突破靜止限制）
- **國家身份**：法國「Alicem」計畫用於公民身份證
- **執法**：比對監控名單 (watchlist)，加速逮捕、解決假身份案件
- **行銷**：Westfield 零售park隱藏攝影機辨識年齡/性別/情緒，推播對應廣告
- **交通**：新南威爾斯以人臉辨識取代刷卡搭乘鐵路

## 三、FR 的社會影響
### 3.1 正面影響
- 廣泛應用於 Microsoft、Facebook、Google 等企業
- 涵蓋安全、醫療、警政、行銷各面向

### 3.2 負面影響
- **英國**：所有社群活動被政府或私人企業監控（監控國家疑慮）
- **澳洲**：申辦駕照/護照的臉部資料可能進入聯邦大型國家資料庫

## 四、結論
- FR 過去 20 年進展顯著，能自動驗證身份用於安全交易、監控、門禁
- 現有應用多在受控環境以取得高準確度
- 下一代 FR 將廣泛應用於智慧環境，機器如同助手
- 未來挑戰：在多變條件下、以單一或多模態資訊可靠地辨識人物，仍需大量研究

---
---

# 六篇論文綜合比較

| # | 論文 | 年份 | 類型 | 核心焦點 | 適合引用章節 |
|---|------|------|------|---------|-------------|
| 1 | Gururaj et al. | 2024 | 技術綜述 | FR 方法分類法、影像/影片式、資料集 | 方法論、技術背景 |
| 2 | Fola-Rose et al. | — | 應用+倫理 | 深度學習架構、深偽、倫理困境 | 動機、倫理討論、深偽 |
| 3 | Lynch | 2024 | 法律/政策 | 執法監控 FRT 的監管（自我監管/EU AI Act/國家立法） | 法規、人權、監管 |
| 4 | Qiang et al. | 2022 | 醫學綜述 | FR 於疾病診斷（內分泌/遺傳/神經退化） | 醫療應用、臨床實例 |
| 5 | Nguyen-Tat et al. | 2024 | 系統實作 | Haar Cascade + Jetson Nano 考勤系統 | 實作、嵌入式、效能評估 |
| 6 | Zarkasyi et al. | 2020 | 社會綜述 | FR 在社會各領域的正負面影響 | 社會應用、動機、影響 |

## 主題交叉索引
- **技術方法**：論文 1（最完整）、論文 2、論文 4（醫療演算法）、論文 5（Haar Cascade 實作）
- **倫理與隱私**：論文 2、論文 3（最深入，法律視角）、論文 4（醫療隱私）、論文 6（社會監控）
- **法規監管**：論文 3（EU AI Act、案例法）、論文 2（美國各州）
- **具體應用**：論文 4（醫療）、論文 5（考勤）、論文 6（國家/交通/行銷）、論文 2（安全/機場）
- **深偽/新興威脅**：論文 2（深偽詐騙案例）
- **深度學習架構**：論文 1、論文 2（CNN/RNN/GAN/Siamese/Capsule）、論文 4（PDBNN/RBF/3D-CNN/LSTM）
