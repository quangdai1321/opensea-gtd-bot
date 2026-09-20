# Bot mint + thông báo drop OpenSea qua Telegram

## Người mới: cài đặt trong 5 phút

Mỗi người dùng **bot Telegram, API key và ví của riêng mình**. Repo không chứa bí mật nào của ai.

1. Cài [Node.js](https://nodejs.org) 20+ rồi:
   ```
   git clone <link repo>
   cd <thư mục repo>
   npm install
   copy .env.example .env        (Linux/Mac: cp .env.example .env)
   ```
2. Điền `.env`: tạo bot Telegram với **@BotFather** → `TELEGRAM_BOT_TOKEN`; nhắn 1 tin cho bot rồi `node notify.mjs chatid` → `TELEGRAM_CHAT_ID`; tạo key tại https://opensea.io/settings/developer → `OPENSEA_API_KEY`.
3. Tạo ví mint (nên là **burner**, chỉ để ít tiền): `node mintbot.mjs setup`. Thêm ví: `node mintbot.mjs addwallet vi2`.
4. Chạy: `node mintbot.mjs` → Telegram báo "🤖 Bot mint đã bật" → gõ `/help`.

**Bảo mật:**
- **Không bao giờ** commit hay gửi cho ai: `.env`, `wallet.keystore.json`, thư mục `wallets/`, `mint-jobs.json`. `.gitignore` đã chặn sẵn.
- Private key chỉ được mã hóa lưu trên máy bạn (scrypt + AES), code không gửi key đi đâu. Bot chỉ kết nối OpenSea, Telegram, RPC công khai.
- Bot chỉ nhận lệnh từ `TELEGRAM_CHAT_ID` của bạn.
- Trước khi `git pull` bản mới, xem qua thay đổi (`git log -p`): code này ký giao dịch bằng ví của bạn.

---

# Noti_tele — Thông báo Telegram khi Codex / Claude Code xong việc

Script `notify.mjs` gửi tin nhắn Telegram khi:
- **Codex** trả lời xong một lượt
- **Claude Code** trả lời xong (`Stop`) hoặc đang chờ bạn duyệt quyền (`Notification`)

Tin nhắn có dạng:
```
[Codex] Bot-Mint - xong viec

<câu trả lời cuối của agent>
```

Chỉ cần Node 18+ (máy đang có Node 24), không cần `npm install`.

## Trạng thái (19/09/2026)

- [x] Viết `notify.mjs`, `.env`, `.gitignore`
- [x] Test dry-run với sự kiện Codex, Claude Stop, Claude Notification và transcript thật: OK
- [ ] Tạo bot, điền token + chat id vào `.env`
- [ ] Chạy `node notify.mjs test`
- [ ] Cài vào Codex và/hoặc Claude Code (xem bên dưới, **chưa cài**)

## File

| File | Vai trò |
|---|---|
| `notify.mjs` | Script chính, dùng chung cho cả Codex và Claude Code |
| `.env` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_SEND_TEXT` |
| `.gitignore` | Chặn commit `.env` |

## Bước 1: Tạo bot và điền `.env`

1. Mở Telegram, chat với **@BotFather** → `/newbot` → đặt tên → nhận **token**.
2. Dán token vào `TELEGRAM_BOT_TOKEN=` trong `.env`.
3. Mở bot vừa tạo, nhắn một tin bất kỳ (ví dụ `hi`).
4. Lấy chat id:
   ```
   node D:\Bot-Mint\Noti_tele\notify.mjs chatid
   ```
   Chép số ở cột trái vào `TELEGRAM_CHAT_ID=`.
5. Gửi thử:
   ```
   node D:\Bot-Mint\Noti_tele\notify.mjs test
   ```
   Điện thoại nhận được "Tin thu tu Noti_tele: ket noi Telegram OK" là xong.

## Bước 2a: Cài cho Codex

Tạo file `%USERPROFILE%\.codex\config.toml` (hiện chưa có) với dòng:

```toml
notify = ["node", "D:/Bot-Mint/Noti_tele/notify.mjs"]
```

Nếu file đã có nội dung, dòng `notify` phải nằm **ở đầu file**, trước mọi mục `[...]`.
Codex tự thêm JSON sự kiện vào cuối lệnh, script chỉ xử lý loại `agent-turn-complete`.

## Bước 2b: Cài cho Claude Code

Thêm khóa `hooks` vào `%USERPROFILE%\.claude\settings.json`. **Giữ nguyên** các khóa đang có (`permissions`, `model`, ...):

```json
"hooks": {
  "Stop": [
    { "hooks": [ { "type": "command", "command": "node D:/Bot-Mint/Noti_tele/notify.mjs" } ] }
  ],
  "Notification": [
    { "hooks": [ { "type": "command", "command": "node D:/Bot-Mint/Noti_tele/notify.mjs" } ] }
  ]
}
```

- `Stop` báo **mỗi lần** Claude trả lời xong, nên có thể hơi nhiều tin. Nếu thấy phiền thì bỏ, chỉ giữ `Notification`.
- `Notification` báo khi Claude đang chờ bạn duyệt quyền hoặc nhập tiếp.
- File này áp dụng cho **mọi** thư mục. Nếu chỉ muốn báo cho một dự án, đặt khóa `hooks` vào `<dự án>/.claude/settings.json`.

Có thể nhờ Claude làm hộ: *"đọc D:\Bot-Mint\Noti_tele\README.md rồi cài bước 2a/2b"*.

## Tùy chọn trong `.env`

| Biến | Giá trị | Ý nghĩa |
|---|---|---|
| `TELEGRAM_SEND_TEXT` | `1` (mặc định) | Gửi kèm câu trả lời cuối của agent (tối đa khoảng 3500 ký tự) |
| | `0` | Chỉ báo "xong viec", không gửi nội dung |

Biến môi trường Windows cùng tên được ưu tiên hơn `.env`.

> **Quyền riêng tư:** với `TELEGRAM_SEND_TEXT=1`, nội dung trả lời của agent sẽ đi qua server Telegram.
> Khi làm việc với ví/keystore trong `Bot-Mint`, nên đặt `0`.

## Test không gửi thật

Đặt `NOTIFY_DRY_RUN=1` để in tin nhắn ra màn hình thay vì gửi (chạy trong Git Bash):

```bash
NOTIFY_DRY_RUN=1 node D:/Bot-Mint/Noti_tele/notify.mjs '{"type":"agent-turn-complete","cwd":"D:/Bot-Mint","last-assistant-message":"Xong roi"}'
echo '{"hook_event_name":"Notification","cwd":"D:/CV","message":"Claude needs your permission"}' | NOTIFY_DRY_RUN=1 node D:/Bot-Mint/Noti_tele/notify.mjs
```

Khi test tay trong Git Bash, dùng `/` trong đường dẫn JSON. Git Bash làm hỏng dấu `\`, còn Codex/Claude Code thì không bị.

## Cách script hoạt động

- **Codex**: JSON sự kiện nằm ở tham số dòng lệnh → lấy `last-assistant-message`.
- **Claude Code**: JSON sự kiện đi vào stdin → với `Stop`, đọc `transcript_path` (file JSONL) để lấy câu trả lời cuối; với `Notification`, lấy `message`.
- Tên dự án là tên thư mục của `cwd`.
- Khi agent gọi, mọi lỗi (thiếu token, mất mạng, Telegram từ chối) chỉ ghi ra stderr rồi **thoát 0**, không làm agent lỗi hay treo. Timeout Telegram 10s, đọc stdin 3s.
- Riêng lệnh tay `chatid` / `test` báo lỗi rõ và thoát 1.

## Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách sửa |
|---|---|
| `Thieu TELEGRAM_BOT_TOKEN` | Chưa điền token trong `.env` |
| `chatid` báo "Chua thay tin nao" | Chưa nhắn tin cho bot, hoặc tin đã quá 24h. Nhắn lại rồi chạy lại |
| `Telegram tu choi: Unauthorized` | Token sai hoặc đã bị revoke ở BotFather |
| `Telegram tu choi: Bad Request: chat not found` | Chat id sai, hoặc bạn chưa bấm Start với bot |
| Không nhận tin, không thấy lỗi | Xem hook đã cài chưa; chạy `node notify.mjs test` để kiểm tra riêng phần Telegram |

## Ghi chú khác

`D:\Bot-Mint\server.js` import `chains.js`, `keystore.js`, `core.js`, `seadrop.js`, `public/index.html`,
nhưng thư mục `Bot-Mint` hiện chỉ có `index.html`, `package.json`, `server.js`, nên `npm start` sẽ lỗi cho tới khi bổ sung đủ.
Việc này không liên quan đến Noti_tele.

## drops.mjs — Báo GTD / WL trên OpenSea

OpenSea **không** cho biết trước ví có trong GTD/WL. Bot làm 2 việc:
1. Nhắc Telegram **60 phút trước** khi một giai đoạn presale (GTD/WL/allowlist) của bất kỳ drop nào, trên mọi chain, sắp mở.
2. Khi giai đoạn đó mở, nhờ OpenSea dựng thử giao dịch mint cho `WATCH_WALLET` (không gửi, không cần private key). Dựng được → báo "✅ Ví bạn có quyền mint". Không có quyền thì im lặng.

```
node drops.mjs              # chạy mãi, quét mỗi 5 phút
node drops.mjs once         # quét 1 lần
node drops.mjs check <slug> # xem các giai đoạn của 1 drop + thử quyền mint của ví
```

`.env` cần thêm: `OPENSEA_API_KEY`, `WATCH_WALLET`. Tùy chọn: `REMIND_MINUTES` (mặc định 60), `POLL_MINUTES` (mặc định 5).
Đã nhắc / đã kiểm tra lưu ở `drops-state.json` để không báo trùng.

**Quan trọng:** danh sách drop công khai của OpenSea không có drop chưa mở. Dự án nào bạn đã đăng ký GTD/WL thì dán link vào `watch.txt` (mỗi dòng 1 link) để bot đọc lịch của dự án đó.

## mintbot.mjs — Auto mint qua contract SeaDrop (Telegram)

Chạy trên máy/VPS (không chạy trên GitHub Actions: lịch trễ và không giữ được private key an toàn).

```
npm install                  # 1 lần, cài ethers
node mintbot.mjs setup       # 1 lần: nhập private key + mật khẩu -> wallet.keystore.json (mã hóa)
node mintbot.mjs             # nhập mật khẩu, bot chạy
```

Ví phụ: chép `wallets/<tên>/keystore.json` (cùng mật khẩu, định dạng của tool cũ) cạnh `mintbot.mjs`.

| Giai đoạn | Cách mint |
|---|---|
| Public | Gọi thẳng `SeaDrop.mintPublic`. Đọc giá/giới hạn từ contract, ký sẵn 60s trước, 4s trước giờ mở dò `eth_call` chồng lần (miễn phí), mở là phát ra mọi RPC |
| GTD / WL (`signed_presale`) | Contract đòi chữ ký OpenSea, chỉ có khi stage mở. Hỏi OpenSea từ 3s trước, **kiểm tra calldata** (đúng SeaDrop, đúng NFT, NFT về đúng ví, đúng số lượng, đúng giá) rồi ký và phát ra mọi RPC |

Trên Telegram: dán link `opensea.io/collection/...` → **⏰ Auto** để hẹn, **⚡ Mint ngay** nếu đang mở, **🧪 Thử** để mô phỏng (không gửi gì).
`/list` xem/hủy hẹn, `/wallets` bật/tắt ví, `/gas 2` hệ số tip gas, `/max 0.01` giới hạn giá + gas mỗi ví mỗi lần, `/bal` số dư. Bot chỉ nghe lệnh từ `TELEGRAM_CHAT_ID`.
RPC riêng nhanh hơn: `RPC_ROBINHOOD=url1,url2` trong `.env`. Ví mint chỉ nên giữ đủ tiền mint + gas.

Code: `lib/engine.mjs` (động cơ), `lib/seadrop.mjs` (ABI chuẩn, dịch lỗi, kiểm tra calldata), `lib/chains.mjs` (RPC, gas), `lib/wallets.mjs` (nạp ví).

## recon.mjs — Soi một drop trước khi cắm bot vào

```
node recon.mjs robinhood 0x54bc2d6dc962ad37003a47362b28b4766ac895da
```

Đọc on-chain và trả lời: stage public giá bao nhiêu, cap mỗi ví bao nhiêu, **trước giờ
public mở thì đã đi mất bao nhiêu hàng**, block mở public bay bao nhiêu cái, và phần đó
về tay ví thường hay về một contract gom nhiều ví.

Cái cần nhìn là dòng cuối. Nếu phần lớn hàng ở block mở public đi qua **một giao dịch
rải NFT ra hàng chục ví khác nhau**, thì đó là cuộc đua số lượng địa chỉ chứ không phải
tốc độ — bot 1 ví vẫn lấy được đúng phần theo cap của nó, nhưng không hơn. Script cũng in
nhịp block của chain để đặt `BURST_SPACING_MS` cho khớp.

**Nếu public chưa mở**, script chuyển sang dự báo: đếm nhịp tiêu thụ 30 phút gần nhất rồi
chiếu tới giờ mở, ước lượng còn bao nhiêu cái cho public. Dùng để quyết định có đáng thức
canh hay không — nhiều drop cạn hàng ngay trong stage allowlist, public mở ra chỉ còn vài cái.

Trên Telegram có bản rút gọn: **`/soi <link opensea>`** (hoặc `/soi robinhood 0x54bc...`).
Lõi phân tích nằm ở `lib/recon.mjs`, dùng chung cho cả dòng lệnh lẫn Telegram.

## legacy/ — Tool mint dòng lệnh cũ

`burst.js`, `race.js`, `snipe.js`, `watch-mint.js`, `run-all.js`... Xem `legacy/README.md` và `legacy/CLI.md`. Chạy trong thư mục `legacy/` với `.env` và `wallets/` riêng (không có trong git).

## Nạp / rút tiền, gom NFT (Telegram)

| Lệnh | Làm gì |
|---|---|
| `/fund robinhood 0.001` | Ví chính gửi 0.001 cho **mỗi** ví phụ đang bật |
| `/withdraw robinhood` | Mỗi ví phụ gửi hết tiền (trừ gas) về ví nhận |
| `/withdrawnft reeveworld` | Mỗi ví phụ chuyển hết NFT (ERC-721) của collection về ví nhận |

Mọi lệnh hiện bản xem trước và nút **✅ Xác nhận** (hết hạn sau 2 phút, bấm 1 lần). Ví nhận = ví chính, hoặc `WITHDRAW_TO` trong `.env`. **Không nhập được địa chỉ nhận qua Telegram**: ai chiếm được Telegram của bạn cũng không rút sang ví khác được.
