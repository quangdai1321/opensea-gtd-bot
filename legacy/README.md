# Tool auto-mint NFT (đa chain EVM)

Dùng được cho mọi collection trên chain EVM. Chỉ cần đổi 4 dòng trong `.env`: `CHAIN`, `CONTRACT`, `CALLDATA`, `VALUE_ETH`.

Preset có sẵn trong `chains.js`: `ethereum`, `base`, `arbitrum`, `optimism`, `polygon`, `bsc`, `avalanche`, `zksync`, `blast`, `scroll`, `linea`, `robinhood`. Chain khác thì điền tay `CHAIN_ID` + `RPC_URL` + `EXPLORER` — tra chain ID chuẩn tại [chainlist.org](https://chainlist.org).

## Cách hoạt động

Script không cần biết ABI của contract. Bạn mint tay **1 lần** qua giao diện OpenSea, sau đó copy lại nguyên phần dữ liệu giao dịch từ block explorer, và script gửi lại giao dịch giống hệt như vậy nhiều lần. Cách này chắc ăn hơn đoán tên hàm mint, vì mỗi contract drop mỗi khác.

## Các bước

### 1. Cài đặt

```bash
npm install
cp .env.example .env
```

### 2. Chuẩn bị ví

- Tạo **ví phụ mới** dành riêng cho việc này. Đừng dùng ví chính.
- Thêm Robinhood Chain vào MetaMask (dùng Chain ID và RPC ở bảng trên).
- Bridge một ít ETH sang. Từ Arbitrum thường rẻ nhất.

### 3. Mint tay 1 lần để lấy calldata

Vào trang collection trên OpenSea, bấm Mint, chọn số lượng, xác nhận bằng ví phụ.

> Số lượng bạn chọn ở bước này sẽ được mã hoá luôn vào calldata. Muốn mỗi giao dịch mint 5 cái thì mint tay 5 cái, rồi script sẽ lặp lại đúng 5 cái mỗi lần.

### 4. Lấy thông số từ explorer

Mở `https://robinhoodchain.blockscout.com`, dán địa chỉ ví, mở giao dịch mint vừa rồi:

| Trường trên explorer | Điền vào `.env` |
|---|---|
| **To** | `CONTRACT` |
| **Raw input** (tab dưới, dạng hex dài) | `CALLDATA` |
| **Value** | `VALUE_ETH` |

### 5. Chạy thử

Để `DRY_RUN=true` trong `.env`, rồi:

```bash
npm run mint
```

Script sẽ kiểm tra số dư, mô phỏng giao dịch bằng `eth_call` và ước lượng gas — nhưng **không gửi gì lên chain**. Nếu báo "Mo phong OK" là ổn.

### 6. Chạy thật

Đổi `DRY_RUN=false`, đặt `LOOPS` theo ý bạn, chạy lại.

## Xử lý lỗi thường gặp

**Mô phỏng thất bại** — thường do một trong bốn nguyên nhân:

- Ví đã mint đủ **100 cái** (limit của public stage).
- `VALUE_ETH` không khớp giá mint. Giá niêm yết bằng USD nên số ETH trôi theo tỷ giá — copy lại value từ giao dịch mới nhất.
- Calldata có chứa chữ ký (signature) kèm thời hạn. Một số drop của OpenSea ký calldata ở backend, hết hạn sau vài phút. Nếu vậy cách replay này không dùng lại được — phải mint tay lại và copy calldata mới mỗi lần, hoặc đọc ABI contract để gọi hàm trực tiếp.
- Stage đã đóng hoặc đã sold out.

**Nonce lệch** — script tự đồng bộ lại nonce sau mỗi lỗi. Nếu vẫn kẹt, đợi vài phút rồi chạy lại.

**Bị rate limit** — RPC công khai giới hạn khá chặt. Tăng `DELAY_MS`, hoặc lấy endpoint riêng miễn phí ở Chainstack/QuickNode/NodeFlare và thay vào `RPC_URL`.

## Ví nào nhận NFT?

Đây là chỗ dễ mất tiền nhất. Chạy trước khi mint thật:

```bash
node inspect.js
```

Công cụ này tách calldata thành từng word 32 byte và chỉ ra word nào là địa chỉ ví. Hai kết quả có thể xảy ra:

**Không thấy địa chỉ ví của bạn trong calldata** → contract dùng `msg.sender`. Ví nào ký thì ví đó nhận. Đổi `PRIVATE_KEY` là xong, không cần làm gì thêm.

**Thấy địa chỉ ví của bạn trong calldata** → contract ghi cứng người nhận. Nếu replay bằng ví khác mà không xử lý, **ví mới trả tiền còn NFT bay về ví cũ**. Điền `ORIGINAL_MINTER` vào `.env` (địa chỉ ví đã mint tay), script sẽ tự thay bằng địa chỉ ví đang chạy.

> Script chỉ thay đúng địa chỉ ghi trong `ORIGINAL_MINTER`, không thay bừa mọi địa chỉ tìm thấy. Calldata thường còn chứa địa chỉ contract và ví nhận phí của marketplace — đụng vào là revert ngay.

`inspect.js` cũng in ra selector 4 byte đầu kèm link tra cứu ở 4byte.directory. Biết tên hàm thật (`mintPublic`, `claim`, `purchase`...) giúp bạn hiểu contract đang làm gì thay vì mò mẫm.

## Chạy nhiều ví

### Tạo khung thư mục

```bash
node setup-wallets.js 10
```

Tạo ra:

```
wallets/
  01/key.txt
  02/key.txt
  ...
  10/key.txt
```

Mở từng `key.txt`, dán private key vào (thay cả dòng comment). Script **không** tự sinh key hộ bạn — bạn tự tạo và tự giữ.

Muốn ví nào mint số lượng khác thì thêm `config.json` vào folder đó:

```json
{ "loops": 3, "valueEth": "0.0002" }
```

### Kiểm tra trước

```bash
node run-all.js --check
```

In ra bảng số dư từng ví, mô phỏng giao dịch, ước lượng gas — **không gửi gì lên chain**. Ví nào thiếu tiền sẽ hiện `THIEU`. Luôn chạy bước này trước.

### Chạy thật

```bash
node run-all.js
```

### State file — đừng bỏ qua

Sau mỗi ví hoàn thành trọn vẹn, script ghi vào `wallets/_state.json`. Chạy lại lần sau sẽ **bỏ qua** các ví đã xong.

Đây là thứ cứu bạn khi RPC rớt giữa chừng. Không có nó, chạy lại lần hai là 6 ví đầu mint đè thêm lượt nữa — mất tiền mà không nhận ra ngay. Muốn cố tình chạy lại từ đầu thì dùng `node run-all.js --reset`.

Kết quả từng ví lưu ở `wallets/<tên>/result.json` gồm danh sách tx hash.

### Về độ trễ

Mặc định nghỉ ngẫu nhiên 5–15 giây giữa các ví (`WALLET_DELAY_MS` + `WALLET_JITTER_MS`), và 2–5 giây giữa các giao dịch trong cùng ví. Đừng hạ xuống 0: RPC công khai rate limit khá chặt, mà 10 ví bắn liên tục thì kiểu gì cũng có ví bị nghẽn giữa chừng.

## Dùng chung trên Linux và Windows

Thư mục project đặt trên ổ NTFS chung, chạy được từ cả hai OS. Ba điều chỉnh để việc này an toàn:

### 1. Mã hoá private key (bắt buộc)

NTFS không lưu quyền POSIX nên `chmod 600` **hoàn toàn vô tác dụng** trên ổ này. Mọi user, mọi tiến trình — kể cả thứ chạy bên Windows — đều đọc được `key.txt`. Nên key phải được mã hoá thay vì dựa vào permission:

```bash
node setup-wallets.js 10     # tạo khung thư mục
# dán private key vào từng wallets/NN/key.txt
node encrypt-keys.js         # mã hoá -> keystore.json, rồi xoá key.txt
```

`keystore.json` là định dạng Web3 Secret Storage chuẩn (scrypt + AES-128-CTR) — cùng thứ MetaMask và geth dùng. Không có mật khẩu thì file đó vô dụng. Từ đó về sau `run-all.js` sẽ hỏi mật khẩu mỗi lần chạy.

Để mật khẩu trong `.env` qua `KEYSTORE_PASSWORD` cũng được, nhưng như vậy là quay lại vạch xuất phát — file `.env` cũng nằm trên NTFS. Chỉ dùng khi cần chạy tự động không người trực.

### 2. Đường dẫn tương đối

`WALLETS_DIR=./wallets` — giữ nguyên dạng tương đối. Đặt đường dẫn tuyệt đối kiểu `/run/media/...` hay `D:\...` thì file `.env` sẽ chỉ chạy được trên một OS.

Quan trọng hơn: để ví ở home directory riêng của từng OS sẽ làm **`_state.json` tách làm hai**. Mint xong bên Linux, khởi động sang Windows chạy tiếp, script không biết là đã mint rồi và làm lại từ đầu. Cứ để tất cả trên ổ chung.

### 3. Line ending

`.gitattributes` đã cấu hình sẵn. Ngoài ra code tự xử lý CRLF khi đọc `key.txt`, nên dán key bằng Notepad trên Windows vẫn chạy bình thường.

### Lệnh tắt

| Việc | Linux | Windows |
|---|---|---|
| Tạo thư mục ví | `./run.sh setup 10` | `run.bat setup 10` |
| Mã hoá key | `./run.sh encrypt` | `run.bat encrypt` |
| Soi calldata | `./run.sh inspect` | `run.bat inspect` |
| Kiểm tra | `./run.sh check` | `run.bat check` |
| Chạy thật | `./run.sh all` | `run.bat all` |

Cả hai wrapper tự chạy `npm install` nếu chưa có `node_modules`.

### Lưu ý về node_modules

`ethers` và `dotenv` đều là JS thuần nên `node_modules` dùng chung giữa hai OS không sao. Nếu sau này bạn thêm package có native binding (`bcrypt`, `sharp`...) thì phải cài lại riêng cho từng OS. Gặp lỗi lạ lúc `npm install` trên NTFS thì xoá `node_modules` cài lại là hết.

## Còn lại

- Chỉ giữ đúng số tiền cần mint trong các ví này. Coi chúng là ví dùng một lần.
- `.gitignore` đã chặn `wallets/` và `.env`. Kiểm `git status` trước lần commit đầu — private key lên GitHub là bot quét sạch trong vài giây.
- Đừng để thư mục này trong folder đang sync Dropbox/Google Drive/OneDrive.
- Mật khẩu keystore mà quên là mất ví. Backup private key ở chỗ khác **trước** khi cho `encrypt-keys.js` xoá file gốc.

## Hai chế độ mint

Đặt bằng `MINT_MODE` trong `.env`.

| | `seadrop` | `calldata` |
|---|---|---|
| Cần cấu hình | `NFT_CONTRACT` | `CONTRACT` + `CALLDATA` + `VALUE_ETH` |
| Giá mint | Đọc từ contract | Bạn tự điền, tự cập nhật |
| Giới hạn ví | Biết trước, tự điều chỉnh | Chỉ biết khi revert |
| Mint 5 cái | 1 giao dịch | 5 giao dịch |
| Ví nhận NFT | Luôn đúng ví ký | Phải vá địa chỉ thủ công |
| Dùng được với | Drop của OpenSea | Mọi contract |

**Ưu tiên `seadrop` nếu collection là drop của OpenSea.** Nó chính xác hơn hẳn ở mọi mặt. Chỉ dùng `calldata` khi contract không phải SeaDrop.

### Chế độ seadrop

```bash
# .env
MINT_MODE=seadrop
NFT_CONTRACT=0x...      # địa chỉ contract NFT, KHÔNG phải địa chỉ SeaDrop
SEADROP_QUANTITY=5      # muốn mint mấy cái mỗi ví
```

Rồi `node run-all.js --check`. Script sẽ:

1. Kiểm tra contract SeaDrop có tồn tại trên chain không. Không có thì báo chuyển sang `calldata` thay vì revert khó hiểu.
2. Gọi `getPublicDrop()` đọc giá, giới hạn mỗi ví, giờ mở/đóng.
3. Với từng ví, gọi `getMintStats()` xem đã mint bao nhiêu, còn được mint bao nhiêu.
4. Tự hạ số lượng cho khớp. Ví đã mint đủ thì bỏ qua, không tốn gas.
5. `staticCall` mô phỏng, rồi mint **một giao dịch duy nhất** với số lượng đó.

Ba điểm đáng chú ý:

**Không cần vá địa chỉ nữa.** `mintPublic` nhận tham số `minterIfNotPayer`, script truyền `address(0)` nghĩa là "người ký cũng là người nhận". Mỗi ví tự nhận NFT của mình, không có chuyện NFT bay về ví khác.

**Rẻ hơn nhiều.** Mint 5 cái là 1 giao dịch chứ không phải 5. Với 10 ví thì chênh 10 giao dịch so với 50.

**Lỗi revert được dịch ra tiếng người.** Thay vì `execution reverted`, bạn nhận được `Vuot gioi han moi vi: tong se la 105, toi da 100` hoặc `Sai so tien: gui 0.001, can 0.01`.

### Chờ đến giờ mở mint

```bash
WAIT_FOR_OPEN=true
```

Script poll `getPublicDrop()` cho đến khi stage mở rồi mới chạy. Lưu ý nó chờ **trước** vòng lặp ví, nên ví đầu tiên bắn ngay khi mở, các ví sau lệch theo `WALLET_DELAY_MS`.

## Khi nào cách này KHÔNG dùng được

Replay calldata hoạt động tốt với **public mint, giá cố định, không chữ ký**. Đây là đa số các drop. Nhưng có mấy trường hợp không áp dụng được:

| Tình huống | Dấu hiệu | Cách xử lý |
|---|---|---|
| **Backend ký calldata có hạn** | Mint tay lần 2 ra calldata khác hẳn dù cùng số lượng | Không replay được. Phải đọc ABI contract và tự tạo signature — thường là bất khả thi từ ngoài. |
| **Allowlist merkle proof** | Calldata rất dài, chứa nhiều đoạn 32 byte | Replay được nhưng **chỉ với đúng ví đó**. Proof gắn với địa chỉ ví. |
| **Dutch auction / giá động** | Giá giảm dần theo thời gian | `VALUE_ETH` phải cập nhật liên tục. Cần sửa script đọc giá on-chain trước mỗi tx. |
| **Trả bằng ERC20** | Trường Value = 0 nhưng vẫn mất token | Điền `PAY_TOKEN` vào `.env`, script tự approve. |
| **Chain không phải EVM** | Solana, Bitcoin Ordinals, Sui, Aptos | Script này vô dụng, cần SDK riêng của từng chain. |

Cách kiểm tra nhanh trước khi đầu tư thời gian: mint tay 2 lần liên tiếp cùng số lượng, so 2 chuỗi calldata. **Giống hệt nhau** thì replay được. Khác nhau thì có chữ ký hoặc nonce bên trong, phải làm cách khác.

## Về giới hạn số lượng mỗi ví

Hầu hết drop giới hạn N cái/ví. Muốn vượt qua thì phải chạy nhiều ví, và chỗ này bạn cần cân nhắc thật:

- Nhiều dự án coi đây là hành vi sybil và loại toàn bộ ví liên quan khỏi airdrop/whitelist về sau.
- Điều khoản của OpenSea cấm thao túng để lách giới hạn.
- Về mặt kỹ thuật thì các ví nạp tiền từ cùng một nguồn rất dễ bị gom cụm bằng phân tích on-chain — nên nó thường không kín như người ta tưởng.

Script này cố tình chỉ hỗ trợ 1 ví. Nếu bạn vẫn muốn chạy nhiều ví thì cứ chạy nhiều lần với `.env` khác nhau, nhưng nên hiểu rõ rủi ro ở trên trước.

## Lưu ý

- Không commit file `.env` lên git. Private key trong đó là toàn quyền kiểm soát ví.
- Nếu calldata có chữ ký hết hạn (trường hợp 3 ở trên), cho tôi biết mấy byte đầu của calldata (4 byte selector, ví dụ `0x161ac21f`) — tôi tra được hàm đó là gì và viết lại script gọi ABI trực tiếp.
