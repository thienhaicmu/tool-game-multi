# Phỏm — Kịch bản bàn chơi (Tay & Tự động)

Tài liệu này là **đặc tả**. Module `desktop/protocol/phom/table-group.cjs` làm đúng từng bước dưới đây; test
`tests/js/phom-table-group.test.mjs` đặt tên theo mã kịch bản (T1, A3…).

## 0. Quy tắc chung

| Quy tắc | Nội dung |
|---|---|
| Vai trò | **KEY**: acc tìm bàn (acc dẫn), **không bao giờ tự bấm Bắt đầu**. **SẴN SÀNG**: acc vào bàn thứ nhất. **CHƯA SẴN SÀNG**: acc vào bàn thứ hai. |
| Vai trò giữ nguyên | Vai trò gắn với acc cho tới khi nhóm giải tán. Bị đá rồi vào lại vẫn giữ vai trò cũ. |
| Bàn | Bàn của nhóm luôn là **bàn chờ công khai trong sảnh** còn ít nhất 3 chỗ, do máy chủ chỉ định (lệnh 307). Người chơi khác vào được bàn này — đó là mục đích. Tool **không tạo bàn riêng** (bàn riêng bắt buộc có mật khẩu nên không ai vào được). |
| Key | Mật khẩu bàn là **do máy chủ trả về** (`ri.pwd`, bàn công khai thì rỗng). Tool không tự sinh key, không bao giờ dùng token đăng nhập làm mật khẩu. |
| Nhịp | Trước **mỗi** lệnh gửi lên server: chờ **ngẫu nhiên 0,8–2,5 giây**. |
| Không dồn dập | Mọi thao tác nhóm chạy trong **một hàng đợi tuần tự**: không bao giờ có 2 acc gửi lệnh cùng lúc, không thao tác nào chen vào thao tác đang chạy. |
| Sẵn sàng | Game có tùy chọn "tự sẵn sàng" lưu trên server (lệnh 363). Tool đặt tùy chọn này **trước khi acc ngồi xuống**: SẴN SÀNG = bật, KEY và CHƯA SẴN SÀNG = tắt. Acc SẴN SÀNG bấm sẵn sàng thêm một lần sau khi ngồi. |
| Cùng bàn | Một acc chỉ được tính "đã vào bàn nhóm" khi chính bàn của nó có acc KEY. |

Giao thức (đọc từ mã game — `requestquickPlayBet` / `onReceiveQuickPlay` / `requestJoinRoom`):
tìm bàn = `[6,"Simms","channelPlugin",{cmd:307,aid:1,gid:8,b:<cược>,inc:false}]`, server trả
`[5,{ri:{rid,b,sid,Mu,pwd},cmd:307|313}]` (số bàn + mật khẩu bàn) hoặc `{mgs:"Không tìm thấy phòng thích hợp!"}`,
rồi game tự vào bàn; vào bàn = `[3,"Simms",rid,pwd]`; sẵn sàng = `[5,"Simms",rid,{cmd:5}]`;
bị đá = `[4,true,2,…,"Bạn thoát vì …"]`.

Trả lời của `307` là **chỗ duy nhất** máy chủ cho biết acc đang ở bàn số bao nhiêu (`TABLE_STATE` cmd 202 không
có số bàn), nên bàn của nhóm phải lấy từ đây — không lấy từ một dòng trong danh sách sảnh.

## 1. Chế độ TAY — thanh công cụ trong từng trình duyệt

Ô ☐ TỰ ĐỘNG trên tool **không tích**. Tool chỉ làm đúng nút người dùng bấm, **không tự làm gì thêm**.

| Mã | Người dùng | Tool làm (theo thứ tự, mỗi bước có nhịp) | Kết quả |
|---|---|---|---|
| **T1** | Chọn Cược, bấm **Tìm bàn** | (1) nếu acc đang ngồi bàn khác → rời bàn · (2) tắt "tự sẵn sàng" · (3) xin bàn chờ công khai ở mức cược đó (307) · (4) chờ game tự vào bàn máy chủ chỉ định · (5) bàn không còn đủ 2 chỗ cho 2 acc kia → rời, xin bàn khác · (6) máy chủ báo "Không tìm thấy phòng thích hợp" → chờ nhịp rồi xin lại, **tối đa 3 phút** mới báo người dùng | Acc = **KEY**. Nhóm mới gồm số bàn (+ mật khẩu nếu máy chủ trả về). Ô SS của mọi trình duyệt tự điền số bàn. Nhóm cũ (nếu có) giải tán; các acc khác vẫn ngồi nguyên chỗ. |
| **T2** | Ô SS = số bàn nhóm, bấm **Vào** | (1) nhận vai trò: chưa ai SẴN SÀNG → SẴN SÀNG, còn lại → CHƯA SẴN SÀNG · (2) nếu đang ngồi bàn khác → rời bàn · (3) đặt "tự sẵn sàng" theo vai trò · (4) vào đúng số bàn đó với mật khẩu máy chủ đã trả về · (5) xác nhận cùng bàn với KEY · (6) SẴN SÀNG: bấm sẵn sàng | Acc vào trước SẴN SÀNG, acc vào sau CHƯA SẴN SÀNG. Vào lỗi → trả lại vai trò cho acc sau. |
| **T2b** | Ô SS = số bàn **khác** nhóm, bấm **Vào** | vào bàn với mật khẩu rỗng (như bấm bàn trong sảnh) | Không có vai trò. |
| **T3** | Bấm **ReJoin** | vào lại bàn nhóm bằng key (như T2, giữ vai trò) | |
| **T4** | Bấm **Bàn khác** (acc KEY) | như T1: rời bàn, tìm bàn chờ khác | Các acc khác **không** tự chuyển; người dùng bấm Vào ở bàn mới. |
| **T5** | Bấm **Thoát** | rời bàn | SẴN SÀNG / CHƯA SẴN SÀNG: trả vai trò. KEY: giữ vai trò (có thể Vào lại). |
| **T6** | *Bị server đá* | **không làm gì**; báo "BỊ ĐÁ · bấm ReJoin" | Vai trò giữ nguyên. |
| **T7** | *Bàn không còn* (Vào/ReJoin báo "Phòng không tồn tại") | giải tán nhóm | Báo "Bàn đã mất — bấm Tìm bàn". |

## 2. Chế độ TỰ ĐỘNG — ô ☐ TỰ ĐỘNG ở cuối tool

Chỉ chạy khi ô **được tích**. Acc KEY = acc đầu tiên (thứ tự A, B, C) đang ở trong game.

| Mã | Tình huống | Tool làm (tuần tự, mỗi bước có nhịp) |
|---|---|---|
| **A1** | Tích ô, **chưa có nhóm** (cần chọn Tiền) | (1) từng acc đang ngồi bàn nào đó → rời bàn · (2) T1 cho acc KEY · (3) T2 cho acc thứ 2 (SẴN SÀNG) · (4) T2 cho acc thứ 3 (CHƯA SẴN SÀNG) · (5) kiểm tra cả nhóm cùng bàn |
| **A2** | Tích ô, **đã có nhóm** (tạo bằng tay) | Giữ nhóm. Acc của nhóm đang không ngồi → vào lại (T3). Acc đang ở game nhưng chưa trong nhóm → vào thêm (T2). |
| **A3** | Một acc **bị đá** | chờ nhịp → vào lại đúng bàn bằng key, giữ vai trò. Tối đa 5 lần/phút/acc; quá → dừng tự vào lại cho acc đó và báo lỗi. |
| **A4** | **Bàn không còn** (vào lại báo "Phòng không tồn tại") | làm lại A1 với cùng Tiền và cùng acc KEY (tìm bàn chờ khác). |
| **A5** | Bấm **Bàn khác** | làm lại A1 (mọi acc rời bàn cũ, tìm bàn chờ khác, gom lại). |
| **A6** | **Bỏ tích** ô | huỷ mọi việc tự động đang chờ; ghế giữ nguyên; nhóm giữ nguyên (tiếp tục bằng tay). |

## 3. Nút trên tool (dùng cho cả hai chế độ)

| Nút | Làm |
|---|---|
| THOÁT BÀN TẤT CẢ | Bỏ tích TỰ ĐỘNG; từng acc rời bàn (có nhịp); nhóm giải tán. |
| ĐÓNG TẤT CẢ | Như trên, rồi đóng 3 trình duyệt. |
| XẾP CỬA SỔ | Xếp lại 3 cửa sổ game. |

## 4. Không bao giờ

- Tự bấm **Bắt đầu** cho chủ bàn.
- **Tạo bàn riêng** (308) hay tự sinh mật khẩu bàn: bàn như vậy người chơi khác không vào được từ sảnh.
- Lấy số bàn từ một dòng trong danh sách sảnh rồi coi đó là bàn của nhóm (xem §5).
- Gửi token đăng nhập hoặc mã lấy từ bàn khác làm mật khẩu.
- Hai acc gửi lệnh cùng một lúc, hoặc gửi lệnh không có nhịp.
- Tự làm bất cứ việc gì khi ô TỰ ĐỘNG không tích (ngoài đúng nút người dùng bấm).

## 5. Vì sao bàn của nhóm phải xin từ lệnh 307 (2026-10-02)

Ba cách lấy bàn, và bằng chứng cho từng cách:

| Cách | Kết quả | Bằng chứng |
|---|---|---|
| Lấy một **số bàn trong danh sách sảnh** rồi cùng vào | Không gom được nhóm | Log 09-21 11:28: B1 và B2 cùng vào số bàn `3738108` (uC=1, Mu=4, cược 100, mật khẩu rỗng) → **mỗi acc thành chủ một bàn mới** (`ps=1`, `C:true`). Thêm nữa: danh sách (cmd 300) **không có bàn nào uC=0**, và mức cược đang chọn có thể **không có bàn nào còn ≥3 chỗ** (ví dụ lúc đó cược 100 có 0 bàn). Và `TABLE_STATE` không chứa số bàn nên sau khi vào, tool cũng **không biết mình ở bàn nào** để báo cho 2 acc kia. |
| **Tạo bàn riêng** (308) | Nhóm ngồi một mình | Phỏm bắt buộc có mật khẩu bàn (log 09-21 12:02: gửi 308 `pwd` rỗng → máy chủ im lặng 3 lần), mà bàn có mật khẩu thì **người chơi khác không vào được từ sảnh**. |
| **Xin bàn chờ công khai** (307, kèm mức cược) | Đúng yêu cầu | Máy chủ tự chọn bàn công khai còn chỗ và trả `ri.rid` + `ri.pwd` — tool biết chính xác số bàn để 2 acc kia vào, và bàn vẫn công khai (log 09-21 11:28: 2 giây sau khi một acc ngồi xuống, một người lạ vào cùng bàn). |

Kéo theo đó, các phần sau đã gỡ vì không còn đường nào chạm tới: bộ lọc bàn (`table-qualify`), khoá tìm bàn
(`find-lock`), máy trạng thái HOST/FOLLOWER cũ (acquireHost / joinFollowers / runDiscovery / recoverHost), hai
thí nghiệm join (`join-experiment`, `host-anchored-join`), `room-scanner`, `shared-room-session`,
`stake-catalog`, `phom-simulator-controller`, ô chọn "người tìm bàn", bảng điều khiển thủ công cũ trong tool, và
(2026-10-02) lệnh tạo bàn riêng 308 + bộ sinh key 6 số.

Kéo theo đó, các phần sau cũng đã gỡ vì không còn đường nào chạm tới: bộ lọc bàn (`table-qualify`), khoá tìm bàn
(`find-lock`), máy trạng thái HOST/FOLLOWER cũ (acquireHost / joinFollowers / runDiscovery / recoverHost), hai
thí nghiệm join (`join-experiment`, `host-anchored-join`), `room-scanner`, `shared-room-session`,
`stake-catalog`, `phom-simulator-controller`, ô chọn "người tìm bàn" và bảng điều khiển thủ công cũ trong tool.
