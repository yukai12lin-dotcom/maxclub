# MaxClub 訂單管理系統（Railway 完整版）

三角洲行動 Max 俱樂部訂單管理系統。  
已包含你之前要求的所有核心功能與最後一輪修改：

## 已完成的功能

- 三角色：管理員 / 老闆 / 打手
- 老闆註冊兩步流程（送資料 → 管理員產生驗證碼 → 老闆輸入後開通）
- **登入已拿掉滑塊**，改為嚴格檢查（帳號必須已開通、未停權、密碼正確）
- 連續密碼錯誤 5 次鎖定 1 小時
- 訂單完整流程：下單 → 接單 → 已進房 → 上傳截圖結單 → 評分
- 催單、取消、延後時間、回報問題、再來一單
- **打手「放下訂單」功能已移除**
- 管理員後台：待驗證老闆列表、一鍵產生驗證碼、新增打手、本月統計、查看所有訂單
- 管理員可查看明文密碼（透過 `PASSWORD_VIEW_KEY` 解密）
- 截圖存本地 `/uploads`，**90 天後自動刪除檔案**（訂單紀錄與金額保留）
- 企業微信通知（填 Webhook 即可）
- 紫色主題 + Logo 位置預留
- 手機優先介面

## 你現在要做的事（按順序）

### 1. 下載這個資料夾
把整個 `maxclub` 資料夾下載到你電腦。

### 2. 註冊 Railway（如果還沒有）
https://railway.app  
用 GitHub 登入即可，有免費額度。

### 3. 在 Railway 新建專案
1. New Project → Empty Project
2. 新增 **PostgreSQL** 資料庫（Add Service → Database → PostgreSQL）
3. 再新增一個 **Empty Service**（之後要部署程式碼用）

### 4. 設定環境變數（非常重要）
在 Empty Service 的 **Variables** 裡加入：

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=這裡隨便打一串很長的亂碼（建議 40 字以上）
PASSWORD_VIEW_KEY=另一串很長的亂碼（跟上面不同）
ADMIN_PASSWORD=你要給管理員用的強密碼
ADMIN_PHONE=0963696619
NODE_ENV=production
```

（可選）
```
WECHAT_WEBHOOK_URL=你的企業微信機器人 Webhook
SCREENSHOT_RETENTION_DAYS=90
```

### 5. 部署程式碼
有兩種方式任選：

**方式 A（最簡單）：用 Railway CLI**
```bash
# 在本機 maxclub 資料夾執行
npm i -g @railway/cli
railway login
railway link   # 選你剛建的專案
railway up
```

**方式 B：用 GitHub**
1. 把 maxclub 丟上 GitHub repo
2. Railway 的 Empty Service → Settings → Connect Repo
3. 選那個 repo，Railway 會自動偵測 Node.js 並部署

### 6. 第一次啟動後
- 用管理員手機 + 你設的 `ADMIN_PASSWORD` 登入
- 到後台新增打手手機號
- 讓老闆去「建立帳號」註冊，你在後台按「產生驗證碼」把碼給他

### 7. 測試帳號建議
- 管理員：你設的 `ADMIN_PHONE` + `ADMIN_PASSWORD`
- 打手：後台新增，密碼預設 123456（可改）
- 老闆：自己註冊 + 你給驗證碼

## 本地測試（可選）
```bash
cd maxclub
cp .env.example .env
# 編輯 .env 填入本地 PostgreSQL 連線字串
npm install
npm start
```
然後開 http://localhost:3000

## 目前已知限制 / 之後可再加
- 雙人單平分目前 schema 已預留 `player2_id`，UI 尚未完整實作指派兩人
- 代客下單（管理員幫客人下單）API 已支援，UI 尚未加按鈕
- 企業微信需要你自己建群機器人並把 Webhook 填進環境變數
- 截圖目前存在 Railway 容器本地，重啟後可能消失（之後可改接 Cloudflare R2 / Supabase Storage）
- 沒有真正的簡訊驗證（依你要求拿掉了）

## 出問題時
把 Railway 的 Deploy Logs 截圖給我，或直接說哪一步卡住，我繼續幫你修。

---
做好後告訴我部署網址，我可以再幫你檢查或加功能。
