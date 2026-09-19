# CLI — Sổ tay lệnh

Mọi lệnh chạy trong thư mục dự án:

```bash
cd /duong/dan/toi/Bot-Mint/legacy
```

Trên Windows đổi thành `cd D:\Game\Bot-Mint` (hoặc ổ tương ứng).

---

## Bảng lệnh

| Lệnh | Làm gì | Có tiêu tiền không |
|---|---|---|
| `npm install` | Cài `ethers` và `dotenv` | Không |
| `node probe.js 0x...` | Dò contract, cho biết nên dùng chế độ nào | Không |
| `node configure.js` | Wizard hỏi từng câu rồi ghi `.env` | Không |
| `node setup-wallets.js 10` | Tạo `wallets/01`…`10` | Không |
| `node encrypt-keys.js` | Mã hoá `key.txt` → `keystore.json` | Không |
| `node inspect.js` | Soi calldata, tìm địa chỉ ví nhận | Không |
| `node run-all.js --check` | Mô phỏng toàn bộ, in bảng số dư | Không |
| `node run-all.js` | **Mint thật** | **Có** |
| `node run-all.js --reset` | Xoá đánh dấu "đã xong" rồi mint thật | **Có** |
| `node server.js` | Giao diện web tại `127.0.0.1:8787` | Không, tới khi bấm nút |

Có thể dùng `npm run` thay thế: `npm run probe`, `npm run config`, `npm run check`, `npm run all`, `npm start`.

---

## Chạy lần đầu

```bash
npm install
node setup-wallets.js 10
```

Dán private key vào từng `wallets/NN/key.txt`, rồi:

```bash
node encrypt-keys.js
```

> Backup private key ra chỗ khác **trước** khi trả lời `y` cho câu hỏi xoá. Quên mật khẩu keystore là mất ví, không khôi phục được.

Kiểm tra keystore giải mã được:

```bash
node -e "
import('./keystore.js').then(async ({loadWalletFromDir, promptPassword}) => {
  const pw = await promptPassword('Mat khau: ');
  const r = await loadWalletFromDir('wallets/01', pw);
  console.log('OK ->', r.wallet.address);
});"
```

---

## Mỗi lần mint collection mới

```bash
node probe.js 0xDIA_CHI_CONTRACT_NFT     # 1. contract này thuộc loại nào
node configure.js                         # 2. điền cấu hình
node run-all.js --check                   # 3. mô phỏng
node run-all.js                           # 4. mint thật
```

Bước 3 phải sạch lỗi mới sang bước 4. Đổi bất kỳ thứ gì trong `.env` thì chạy lại bước 3.

---

## Đọc kết quả `probe.js`

| Dòng quan trọng | Nghĩa là | Đặt `MINT_MODE` |
|---|---|---|
| `mintPrice = 0.0001 (native)` | SeaDrop chuẩn, trả bằng coin native | `seadrop` |
| `mintPrice = 0.0` | Trả bằng ERC-20 (ví dụ USDG) | `calldata` + `PAY_TOKEN` |
| `Khong co SeaDrop tai 0x00005EA0...` | Chain không có SeaDrop chuẩn | `calldata` |
| `getPublicDrop() that bai` | Contract không đăng ký với SeaDrop | `calldata` |

---

## Chế độ calldata

Chỉ dùng khi `probe.js` bảo vậy. Cần mint tay 1 cái trên OpenSea trước.

Mở giao dịch đó trên block explorer, lấy 3 trường:

| Trên explorer | Vào `.env` |
|---|---|
| **To** | `CONTRACT` |
| **Raw input** | `CALLDATA` |
| **Value** | `VALUE_ETH` |

Nếu **Value = 0** mà vẫn mint được thì mint trả bằng ERC-20 — xem mục **Tokens Transferred** để lấy địa chỉ token, điền vào `PAY_TOKEN`.

Rồi kiểm tra xem contract có ghi cứng địa chỉ người nhận không:

```bash
node inspect.js
```

Thấy `*** DAY LA VI CUA BAN ***` thì điền `ORIGINAL_MINTER` bằng địa chỉ ví đã mint tay. Không thấy thì bỏ trống.

---

## Biến trong `.env`

Wizard `configure.js` điền hộ hầu hết. Bảng này để sửa tay khi cần.

### Chung

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `CHAIN` | — | `robinhood`, `base`, `ethereum`… xem `chains.js` |
| `CHAIN_ID` / `RPC_URL` / `EXPLORER` | — | Dùng thay `CHAIN` cho chain chưa có sẵn |
| `MINT_MODE` | `calldata` | `seadrop` hoặc `calldata` |
| `WALLETS_DIR` | `./wallets` | Giữ đường dẫn tương đối để dùng chung Linux/Windows |
| `KEYSTORE_PASSWORD` | — | Bỏ trống để script hỏi mỗi lần (an toàn hơn) |
| `GAS_MULTIPLIER` | `1.3` | Hệ số nhân thêm vào gas ước lượng |

### Chế độ seadrop

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `NFT_CONTRACT` | — | Địa chỉ contract NFT |
| `SEADROP_QUANTITY` | `1` | Số lượng mỗi ví, tự hạ nếu vượt giới hạn |
| `WAIT_FOR_OPEN` | `false` | `true` = chờ tới giờ mở mint |
| `SEADROP_POLL_MS` | `5000` | Nhịp kiểm tra khi đang chờ |
| `SEADROP_ADDRESS` | `0x00005EA0…` | Chỉ sửa nếu chain dùng địa chỉ khác |

### Chế độ calldata

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `CONTRACT` | — | Trường "To" |
| `CALLDATA` | — | Trường "Raw input" |
| `VALUE_ETH` | `0` | Trường "Value" |
| `PAY_TOKEN` | — | Địa chỉ ERC-20 nếu trả bằng token |
| `ORIGINAL_MINTER` | — | Ví đã mint tay, để vá địa chỉ người nhận |
| `LOOPS` | `1` | Số giao dịch mỗi ví |
| `FAST` | `false` | `true` = không chờ xác nhận giữa các giao dịch |

### Nhịp độ

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `DELAY_MS` | `2000` | Nghỉ giữa các giao dịch trong cùng ví |
| `JITTER_MS` | `3000` | Cộng thêm ngẫu nhiên |
| `WALLET_DELAY_MS` | `5000` | Nghỉ giữa các ví |
| `WALLET_JITTER_MS` | `10000` | Cộng thêm ngẫu nhiên |

Đừng hạ về 0. RPC công khai rate limit khá chặt, 10 ví bắn liên tục kiểu gì cũng có ví bị nghẽn.

---

## File state

`wallets/_state.json` ghi lại ví nào đã mint xong. Lần chạy sau tự bỏ qua chúng.

Đây là thứ ngăn mint đè khi RPC rớt giữa chừng. Chạy lại mà không có nó thì các ví đầu mint thêm lượt nữa — mất tiền mà thường không nhận ra ngay.

```bash
cat wallets/_state.json          # xem ví nào đã xong
node run-all.js --reset          # cố tình chạy lại tất cả
```

Kết quả từng ví kèm tx hash nằm ở `wallets/NN/result.json`.

---

## Lỗi thường gặp

| Thông báo | Nguyên nhân | Cách xử lý |
|---|---|---|
| `Could not read package.json` | Đang đứng sai thư mục | `ls package.json` để kiểm tra |
| `Cannot find module './chains.js'` | Thiếu file | Tải đủ 12 file `.js` |
| `Sai mat khau keystore` | Gõ nhầm mật khẩu | Thử lại; sai thật thì khôi phục từ backup |
| `Khong tim thay thu muc ./wallets` | Chưa tạo ví | `node setup-wallets.js 10` |
| `So du khong du` | Ví thiếu ETH | Bridge thêm, chạy `--check` tới khi báo `du` |
| `Vuot gioi han moi vi` | Ví đã mint đủ | Bình thường, script tự bỏ qua |
| `Stage chua mo` | Chưa tới giờ | Đặt `WAIT_FOR_OPEN=true` |
| `qua 15s khong phan hoi` | RPC chết hoặc mất mạng | Đổi `RPC_URL`, hoặc lấy endpoint riêng |
| `Host not in allowlist` | Firewall/proxy chặn | Kiểm tra cấu hình mạng |
| Server web tự tắt | Thoát terminal | Chạy lại `node server.js` |

---

## Ghi chú riêng cho ổ NTFS

Thư mục này nằm trên ổ NTFS dùng chung với Windows, nên:

- `chmod` **không có tác dụng**. Bảo mật key nằm ở `keystore.json` đã mã hoá, không phải ở quyền file.
- Giữ `WALLETS_DIR` dạng tương đối. Đặt đường dẫn tuyệt đối sẽ làm `_state.json` tách làm hai bản giữa Linux và Windows → mint đè khi đổi OS.
- `npm install` đôi khi chậm hoặc lỗi symlink. Gặp lỗi lạ thì `rm -rf node_modules && npm install`.
- Code tự xử lý CRLF, nên dán key bằng Notepad trên Windows vẫn chạy.

---

## Trước lần commit git đầu tiên

```bash
git status
```

`wallets/` và `.env` **không được** xuất hiện trong danh sách. Nếu có, kiểm tra `.gitignore`. Private key lên GitHub là bot quét sạch ví trong vài giây.
