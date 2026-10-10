# Phỏm — Kịch bản ĐÁNH BÀI (tab "Đánh bài")

Tài liệu này là **đặc tả** phần đánh bài của tool Phỏm QA: từng lượt trong một ván, tool **gợi ý** gì và **nút** nào
làm gì. Code làm đúng các bước dưới đây:

| Phần | File |
|---|---|
| Tính gợi ý (thuần, không I/O) | `desktop/protocol/phom/phom-play-help.cjs` |
| Bấm nút của game | `desktop/protocol/phom/play-actions.cjs` + `desktop/phom/features/play-actions.cjs` (IPC `phom:play-action`) |
| Theo dõi bài trên bàn | `desktop/protocol/phom/phom-card-observer.cjs`, `phom-frame-classify.cjs`, `hand-reducer.cjs` |
| Giao diện | `ui-phom/phom-qa.js` (`renderPlay`, `playBar`, `autoPlaySwitch`) + `ui-phom/phom-qa.css` |
| Tự đánh (§7) | `desktop/protocol/phom/phom-auto-play.cjs` (chọn nước, thuần) + `desktop/phom/features/auto-play.cjs` (IPC `phom:auto-play`) |
| Test | `tests/js/phom-play-help.test.mjs`, `phom-play-actions.test.mjs`, `phom-send-856.test.mjs`, `phom-auto-play.test.mjs` |

Kịch bản **vào bàn** (Dò Key, Tạo, Vào, ReJoin…) nằm ở `docs/phom-kich-ban.md`.

---

## 0. Quy tắc chung

| Quy tắc | Nội dung |
|---|---|
| Người bấm | Người dùng bấm từng nước. **Tự đánh** (§7) bật riêng từng acc; có người ngoài tool trong ván vẫn chạy. |
| Nút = nút của game | Mỗi nút gọi đúng hàm xử lý nút của game (`PhomController.onBtn…`), chỉ khi game **đang hiện** nút đó (`activeInHierarchy` + `cc.Button.interactable`). Không gửi gói tin đánh bài tự chế. Chưa tới lượt → báo "Game chưa cho … lúc này". |
| Ranh giới thông tin | Gợi ý **chỉ** dùng **bài trên tay của chính acc đó** + **thông tin công khai** (lá đã đánh, lá bị ăn, phỏm đã hạ, lá đã gửi, thứ tự lượt). `publicView()` xoá bài của mọi người khác — kể cả 2 acc còn lại của tool — trước khi tính. Vì vậy kết quả có thể khác **Lọc bài** (tab Phỏm), vốn dùng bài của cả 3 acc. |
| Một tab = một acc | Tab P1/P2/P3. Tab tự nhảy theo acc **đang tới lượt** (trừ khi người dùng bấm chọn tab khác). |
| Một thao tác một lúc | Mỗi acc chỉ chạy 1 thao tác tại một thời điểm (bấm đúp chỉ gửi 1 lần — `PHOM_PLAY_BUSY`). |
| Tính lại liên tục | Gợi ý tính lại **mỗi khi bàn thay đổi** (bốc, đánh, ăn, hạ, gửi) — áp dụng cho **mọi lượt**. |
| Tắt tính năng | `PHOM_FEATURES_OFF=play-actions` tắt các nút (gợi ý vẫn hiện). |

## 1. Khái niệm

| Khái niệm | Định nghĩa trong tool |
|---|---|
| Mã lá | `code = số × 4 + chất`; số 0..12 = A..K (A nhỏ, Q-K-A **không** là phỏm), chất 0..3 = ♠ ♣ ♦ ♥. Trùng `serverCode` của game. |
| Phỏm | 3–4 lá **cùng số** (phỏm ngang) hoặc ≥3 lá **cùng chất liền nhau** (phỏm dọc) — `classifyMeld` (`phom-rules.cjs`). |
| Điểm | Tổng điểm **lá rác** (không nằm trong phỏm): A = 1 … K = 13. Ít điểm hơn = tốt hơn. |
| Cách xếp tốt nhất | Cách chia phỏm (không trùng lá) để điểm rác **thấp nhất** — `bestArrangement` (thử hết; một lá thuộc 2 phỏm được xét cả 2 cách). |
| Người đánh cho mình | Người chơi **ngay trước** acc (theo thứ tự lượt công khai `nextOf`). Chỉ lá của người này mới **ăn** được. |
| Người ăn được lá mình | Người chơi **ngay sau** acc. Mức an toàn của một lá là đối với người này. |
| Mức an toàn | **Chắc chắn không bị ăn** (`SAFE`): dữ liệu công khai chứng minh người sau không thể có 2 lá ghép phỏm với lá đó. **Có thể không bị ăn** (`LIKELY_SAFE`): hàng số đã chặn và tối đa 1 cửa dọc còn mở. **Có thể bị ăn**: còn lại. (Bộ phân tích `phom-safe-card-analyzer.cjs` chạy trên `publicView`.) |
| Cạ | 2 lá rác sẽ thành phỏm nếu có thêm 1 lá: **đôi** (cùng số) hoặc **cùng chất cách 1–2 nút**. Chỉ tính **cạ sống** — lá còn thiếu có thể vẫn chưa ra (chưa bị đánh / hạ / ăn / gửi). Cạ chết không được giữ. — `caPartners` |
| Lượt | Mỗi người **đánh 4 lần** trong ván (nọc = 4 × số người − 1 lá; người đánh trước có sẵn 10 lá thay cho lần bốc đầu). Lượt = số lá acc **đã đánh** + 1. **Đã đánh 3 lá ⇒ lượt tới là lượt cuối (lượt hạ).** — `turnInfo` |
| Phá phỏm | Đánh một lá đang nằm trong cách xếp tốt nhất. Luôn xếp **cuối** danh sách nên đánh (giống Lọc bài). |
| Lá đã ăn | Lá acc đã ăn **phải nằm trong phỏm**: không bao giờ được gợi ý đánh; mọi cách hạ phải chứa nó. |

## 2. Kịch bản từng lượt

### Đ0 — Chia bài (gói 850)
- Mỗi acc nhận 9 lá (người đánh trước 10 lá). Tab hiện **Bài trên tay**, điểm hiện tại, màu an toàn từng lá.
- Đầu ván gần như chưa có thông tin công khai ⇒ hầu hết lá là **có thể bị ăn**; hai nhóm an toàn đầy dần theo ván.

### Đ1 → Đ3 — Các lượt trước lượt cuối (acc đã đánh 0, 1, 2 lá)

Mỗi lượt gồm **lấy 1 lá** rồi **đánh 1 lá** (người đánh trước ở lượt 1 chỉ đánh).

**Bước 1 — Ăn hay Bốc**

| Tình huống | Tool hiện | Nút |
|---|---|---|
| Người trước vừa đánh lá X, X ghép được phỏm với bài trên tay | Khu **Trên bàn**: "Lá … vừa đánh: X — **ăn được** (phỏm …) · còn N điểm" (nền xanh) | **Ăn X** → `onBtnAnBai` |
| X không ghép được phỏm | "… — không ghép được phỏm" | **Bốc** → `onBtnRutBai` |
| Lá vừa đánh đã có người ăn / chưa có lá | ghi rõ | **Bốc** |

Game tự kiểm luật ăn (ví dụ không cho 2 lá ăn trong cùng một phỏm); tool chỉ báo tham khảo.

**Bước 2 — Đánh** (thứ tự gợi ý ở lượt 1–3)

1. **Không bị ăn**: *chắc chắn không bị ăn* → *có thể không bị ăn* → còn lại. Lá an toàn đứng trước **kể cả khi nhiều điểm hơn**.
2. **Giữ cạ sống**: trong cùng mức an toàn, lá **không** thuộc cạ nào đánh trước; lá thuộc cạ được giữ để chờ thành phỏm (nhãn tím **cạ**).
3. **Điểm**: điểm còn lại sau khi đánh **thấp nhất** (thường = bỏ lá rác điểm cao nhất).
4. Lá **phá phỏm** luôn đứng sau mọi lá rác; lá **đã ăn** không bao giờ được gợi ý.

Hiển thị: dòng **Nên đánh: X** (lá đứng đầu) + khu **Gợi ý đánh · lượt k/4 — không bị ăn → giữ cạ → điểm** với 2 nhóm
*Chắc chắn không bị ăn (n)* và *Có thể không bị ăn (n)*. Không có lá an toàn ⇒ "Chưa có lá nào chắc chắn / có thể không
bị ăn — lá ít rủi ro nhất: X". Bấm một lá trong gợi ý = chọn lá đó; nút **Đánh lá đã chọn** → `onBtnDanhBai`.

### Đ4 — Lượt cuối / lượt hạ (acc đã đánh 3 lá)

Thứ tự trong lượt: **lấy lá (Ăn / Bốc) → ① Hạ → ② Gửi → ③ Đánh**. Khu **Gợi ý lượt hạ** tính cả lượt một lần:

1. Thử **mọi cách hạ** (mọi tổ hợp phỏm không trùng lá; lá đã ăn phải nằm trong phỏm được hạ).
2. Với mỗi cách hạ và mỗi lá có thể đánh: **gửi** mọi lá rác còn lại ghép được vào phỏm **đang có trên bàn**, gửi **nối tiếp**
   (gửi 6♥ vào 3♥4♥5♥ rồi 7♥ theo sau) — `sendChain`.
3. Chọn phương án theo thứ tự của **lượt cuối** (không xét cạ — không còn lượt bốc):
   **lá đánh không bị ăn** (chắc chắn → có thể) → **điểm còn lại thấp nhất** → hạ nhiều phỏm hơn → gửi nhiều lá hơn.
   Một lá gửi được vẫn có thể được **giữ lại để đánh** nếu nó là lá an toàn nhất.
   **Lá cuối của ván** (người sau đã đánh đủ 4 lá — không ai ăn được nữa): mọi lá coi là an toàn, chỉ xét điểm còn
   lại (2026-10-10; mô phỏng: +0,15…+0,24 cược/ván cho nhóm tool).

| Bước | Tool hiện | Người dùng |
|---|---|---|
| ① Hạ | các phỏm cần hạ | **Chọn bộ hạ** → bấm **Hạ n lá** (`onBtnHaPhom`) |
| ② Gửi | "X → phỏm … (của ai)" | **Chọn lá gửi** → bấm **Gửi n lá** (`onBtnGuiBai`) |
| ③ Đánh | lá đánh + mức an toàn | **Chọn lá đánh** → bấm **Đánh** |

Không còn lá rác ⇒ "hết bài rác" (xem Ù).

### Ù
- Nút **Ù** → `onBtnBaoU`, chỉ khi game hiện nút Ù. Game cũng **tự** báo Ù trong một số trường hợp (bài 3 phỏm / đủ 9 lá phỏm).

### Kết thúc ván (gói 855)
- Bảng điểm ván do game hiện. Gói chia bài mới (850) bắt đầu ván mới: lịch sử đánh / gửi / cạ / lượt tính lại từ đầu.

## 3. Kiểm tra trước khi bấm (khi có lá chọn ở tool)

`checkPlay` — sai thì **không bấm**, báo lý do ở dòng ghi chú:

| Nút | Điều kiện |
|---|---|
| Mọi nút có lá | Mọi lá chọn còn trên tay. |
| Đánh | Đúng **1** lá; không phải lá đã ăn. |
| Hạ | Các lá chọn **chia hết thành phỏm** hợp lệ. |
| Gửi | Mọi lá chọn gửi được (tính cả gửi nối tiếp, thứ tự chọn không quan trọng). |
| Không chọn lá nào | Đánh / Hạ / Gửi dùng lá **đang chọn trong cửa sổ game**; game tự kiểm. |

Game vẫn là bên quyết định cuối ("Phải hạ phỏm trước khi đánh bài", "Hạ phỏm không hợp lệ", …).

## 4. Giao thức và nút của game (đọc từ bundle `project.*.js`, 2026-10-09)

| Gói | Lệnh | Ý nghĩa | Tool đọc |
|---|---|---|---|
| 850 | DEAL | chia bài (`cs`, `lpi`) | ✔ |
| 851 | PLAY (DANH_BAI 857 phía client) | đánh (`fP.dCs`, lượt kế `tP.uid`) | ✔ — học thứ tự lượt `nextOf` |
| 852 | DRAW | bốc; phiên của chính acc có `sAC` (cả bài) + `sMs` (phỏm máy chủ xếp) | ✔ |
| 853 | TAKE_CARD | **ăn** (không phải hết ván) | ✔ |
| 854 | HA_PHOM | hạ phỏm công khai (`mes[{meid, cs}]`) | ✔ |
| 855 | FINISH_GAME | hết ván | ✔ |
| 856 | GUI_BAI | **gửi** công khai (`uid`, `aMs[{cs, meid}]`); máy chủ chọn phỏm, client chỉ gửi `cs` | ✔ (từ 208911b) |

| Nút | Node | Hàm | Lá |
|---|---|---|---|
| Bốc | `btnRutBai` | `onBtnRutBai` → `requestDrawCard` | — |
| Ăn | `btnAnBai` | `onBtnAnBai` → `requestTakeCard(currentTakeCardID)` | — |
| Đánh | `btnDanhBai` | `onBtnDanhBai` → `requestPlayCard` (1 lá đang chọn) | chọn qua `myCardSet.setListCardSelected([code])` |
| Hạ | `btnHaPhom` | `onBtnHaPhom` → `requestHaPhom` (≥3 lá đang chọn) | như trên |
| Gửi | `btnGuiBai` | `onBtnGuiBai` → `requestGuiBai` | như trên |
| Ù | `btnBaoU` | `onBtnBaoU` → `requestBaoU` | — |

Controller tìm bằng `cc.director.getScene().getComponentInChildren('PhomController')` (chỉ có ở PhomScene).

## 5. Trạng thái và việc còn mở

| Việc | Trạng thái |
|---|---|
| Thử trong **ván thật**: Bốc · Ăn · Đánh lá gợi ý · Hạ → Gửi → Đánh theo gợi ý · Ù · bấm sai lượt bị chặn · **điểm tool khớp điểm game** · đếm lượt đúng (cả người đánh trước 10 lá) | **CHƯA** |
| Luật ăn chi tiết (2 lá ăn không cùng phỏm, ăn chốt, …): hiện để game tự kiểm | mở |
| "Gửi" vào phỏm của **chính mình** lúc hạ: hiện tính như phỏm lớn hơn trong cách xếp | mở |
| Ù khan, móm, đền… (tính tiền cuối ván): chưa tính | mở |
| Bàn < 4 người: cách đếm lượt dựa trên số lá đã đánh — cần kiểm chứng | mở |
| Tự đánh (§7) trong ván thật: đủ Đ1–Đ4, Ù, tiếp tục khi có người ngoài tool | **CHƯA** |
| Nút Hạ của game hiện lúc nào (chỉ lượt cuối?) — tự đánh đang dựa vào đếm lượt của tool | mở |
## 7. Tự đánh (từng acc)

Ghi chú nâng cấp: Tự đánh có hai tùy chọn **Nuôi ít tiền** (mặc định tắt) và **Ưu tiên 2 phỏm + cạ ù** (**mặc định bật** từ 2026-10-10 — mô phỏng: +0,38 cược/ván cho nhóm tool, ù ×2,7; ai đã tự tắt thì vẫn tắt). **Chặn ăn lần 3 luôn bật, với mọi người ngồi sau** (user 2026-10-10), không ngoại lệ cạ ù: người sau là acc tool ⇒ chặn chính xác theo bài của nó; người ngoài đã ăn 2 lá ⇒ chỉ đánh lá **chắc chắn không bị ăn** theo thông tin công khai, không có thì đánh lá ít rủi ro nhất và báo "không có lá tránh ăn hợp lệ". Hai nhánh cạ ù / nuôi ít tiền chỉ áp dụng khi người sau là acc trong tool; với người ngoài (người sau / người trước) Tự đánh giữ kịch bản bình thường. Thứ tự: đúng luật → chặn ăn lần 3 → cạ ù hợp lệ → nuôi ít tiền → mặc định. Tiền thiếu không được coi là 0. Chi tiết và công cụ replay: `docs/phom-auto-play-upgrade.md`.

Công tắc **Tự đánh** ở cuối thanh nút của tab Đánh bài — bật riêng cho **từng acc** (P1/P2/P3). Mặc định tắt.

| Quy tắc | Nội dung |
|---|---|
| Quyền key | Chỉ key PHOM có tích **"Cho dùng Tự đánh"** ở Generator (ký trong `features.autoRun`) mới bật được. Key ký trước khi có ô này ⇒ không có quyền (cấp key mới). Không có quyền ⇒ công tắc khoá + "Key chưa có quyền Tự đánh"; main cũng từ chối (`PHOM_AUTO_PLAY_NOT_LICENSED`); đang chạy mà mất quyền (đổi key) ⇒ tự tắt. Dev bypass: được dùng. |
| Bấm như người | Đọc nút game đang hiện (chỉ đọc), rồi bấm qua đúng đường của nút trên tool (`checkPlay`, một thao tác một lúc). Nút Ù được ưu tiên khi game hiện. Một nước chỉ bấm sau một khoảng nghỉ **ngẫu nhiên 0,8–2,5 giây** mà nước đó giữ nguyên (nhịp như người, chờ bàn cập nhật; 2026-10-10) và không bấm lại cùng một nước khi **những gì nước đó phụ thuộc** chưa đổi (`stateKey`: bài/phỏm/lá đánh/lá gửi của chính acc + lá trên bàn + lá bị ăn — gói tin bài riêng của 2 acc kia không tính, nên không bấm lặp và không thử lại Ăn đã bị từ chối). |
| 3 acc cùng bật | Mỗi lượt kiểm tra các acc **song song**; mỗi lần gọi trang có giới hạn 5 giây (một trình duyệt treo không giữ 2 acc còn lại, nút không bị kẹt "đang thực hiện"). Acc đang Tự đánh thì nút bấm tay trên tool của acc đó bị từ chối (`PHOM_PLAY_AUTO_ON`) — tắt Tự đánh trước khi bấm tay. |
| Tự tắt | Mất quyền key · trình duyệt không trả lời khi bấm · `checkPlay` hoặc game từ chối (không ở bàn, lá không còn trên tay…) · bấm xong 6 giây bàn không đổi (riêng **Ăn** bị từ chối thì chuyển sang **Bốc**) · game hiện nút nhưng 12 giây không có nước hợp lệ (ví dụ có phỏm cần hạ/gửi mà game chưa hiện nút) · trang tải lại · đóng trình duyệt. **Tự bật lại** (2026-10-10): trừ khi bạn tự tắt, key mất quyền, đóng trình duyệt — công tắc vẫn bật, chờ acc về bàn Phỏm rồi tự chạy tiếp; tối đa **3 lần / 10 phút**, không về bàn trong 2 phút hoặc quá 3 lần ⇒ tắt hẳn. Lý do và số lần hiện cạnh công tắc, kèm số ván · số lần dừng trong phiên. |
| Tắt tính năng | `PHOM_FEATURES_OFF=auto-play` (hoặc `play-actions`, vì tự đánh bấm qua đó). |

## 6. Lịch sử

| Commit | Nội dung |
|---|---|
| f1c54a3 | Nút Bốc/Ăn/Đánh/Hạ/Gửi bấm nút của game |
| ce6f3e4 | Tab Đánh bài riêng, chọn nhiều lá; Lọc bài chỉ để xem |
| 208911b | Đọc gói Gửi 856 |
| 37d57f4 | `phom-play-help.cjs`: điểm, cách xếp, thứ tự đánh, kế hoạch hạ, ăn, gửi |
| 791a489 | Giao diện: Trên bàn, màu an toàn, Nên đánh, gợi ý hạ / gửi, Ù, kiểm tra trước khi bấm |
| 2b40377 | Khu Gợi ý đánh (2 nhóm an toàn), áp dụng mọi lượt |
| 5cf46c9 | Giữ cạ sống ở lượt 1–3; lượt cuối như cũ |
| 70c2454 | Lượt hạ = Hạ → Gửi → Đánh, điểm thấp nhất |
| 1fb02e8 | Tự đánh từng acc, chỉ bàn toàn acc tool (§7); tab Đánh bài cập nhật theo bàn |
| (chưa commit) | Tự đánh: quyền key "Cho dùng Tự đánh"; acc ở bàn khác ⇒ tắt; 3 acc song song, gọi trang có giới hạn; chặn bấm tay khi đang tự đánh |
