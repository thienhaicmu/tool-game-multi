# Phỏm — Kịch bản bàn chơi (Tay & Tự động)

Tài liệu này là **đặc tả**. Module `desktop/protocol/phom/table-group.cjs` làm đúng từng bước dưới đây; test
`tests/js/phom-table-group.test.mjs` đặt tên theo mã kịch bản (T1, A3…).

## 0. Quy tắc chung

| Quy tắc | Nội dung |
|---|---|
| Vai trò | **KEY**: acc tạo bàn (chủ bàn), giữ key, **không bao giờ tự bấm Bắt đầu**. **SẴN SÀNG**: acc vào bàn thứ nhất. **CHƯA SẴN SÀNG**: acc vào bàn thứ hai. |
| Vai trò giữ nguyên | Vai trò gắn với acc cho tới khi nhóm giải tán. Bị đá rồi vào lại vẫn giữ vai trò cũ. |
| Key | Mỗi bàn tạo mới có key **6 số ngẫu nhiên**. Key chỉ dùng giữa các acc của tool. Không bao giờ dùng token đăng nhập làm key. |
| Nhịp | Trước **mỗi** lệnh gửi lên server: chờ **ngẫu nhiên 0,8–2,5 giây**. |
| Không dồn dập | Mọi thao tác nhóm chạy trong **một hàng đợi tuần tự**: không bao giờ có 2 acc gửi lệnh cùng lúc, không thao tác nào chen vào thao tác đang chạy. |
| Sẵn sàng | Game có tùy chọn "tự sẵn sàng" lưu trên server (lệnh 363). Tool đặt tùy chọn này **trước khi acc ngồi xuống**: SẴN SÀNG = bật, KEY và CHƯA SẴN SÀNG = tắt. Acc SẴN SÀNG bấm sẵn sàng thêm một lần sau khi ngồi. |
| Cùng bàn | Một acc chỉ được tính "đã vào bàn nhóm" khi chính bàn của nó có acc KEY. |

Giao thức (đọc từ mã game): tạo bàn = `311` (hỏi cược được tạo) → `308 {b, Mu:4, pwd:key}`, server trả
`ri.rid` (số bàn) và game tự vào bàn; vào bàn = `[3,"Simms",rid,key]`; sẵn sàng = `[5,"Simms",rid,{cmd:5}]`;
bị đá = `[4,true,2,…,"Bạn thoát vì …"]`.

## 1. Chế độ TAY — thanh công cụ trong từng trình duyệt

Ô ☐ TỰ ĐỘNG trên tool **không tích**. Tool chỉ làm đúng nút người dùng bấm, **không tự làm gì thêm**.

| Mã | Người dùng | Tool làm (theo thứ tự, mỗi bước có nhịp) | Kết quả |
|---|---|---|---|
| **T1** | Chọn Cược, bấm **Tạo** | (1) nếu acc đang ngồi bàn khác → rời bàn · (2) tắt "tự sẵn sàng" · (3) hỏi cược được tạo (311) · (4) tạo bàn có key (308) · (5) chờ game tự vào bàn | Acc = **KEY**. Nhóm mới gồm số bàn + key. Ô SS của mọi trình duyệt tự điền số bàn. Nhóm cũ (nếu có) giải tán; các acc khác vẫn ngồi nguyên chỗ. |
| **T2** | Ô SS = số bàn nhóm, bấm **Vào** | (1) nhận vai trò: chưa ai SẴN SÀNG → SẴN SÀNG, còn lại → CHƯA SẴN SÀNG · (2) nếu đang ngồi bàn khác → rời bàn · (3) đặt "tự sẵn sàng" theo vai trò · (4) vào bàn bằng key · (5) xác nhận cùng bàn với KEY · (6) SẴN SÀNG: bấm sẵn sàng | Acc vào trước SẴN SÀNG, acc vào sau CHƯA SẴN SÀNG. Vào lỗi → trả lại vai trò cho acc sau. |
| **T2b** | Ô SS = số bàn **khác** nhóm, bấm **Vào** | vào bàn với mật khẩu rỗng (như bấm bàn trong sảnh) | Không có vai trò. |
| **T3** | Bấm **ReJoin** | vào lại bàn nhóm bằng key (như T2, giữ vai trò) | |
| **T4** | Bấm **Đổi Key** (acc KEY) | như T1: tạo bàn mới, key mới | Các acc khác **không** tự chuyển; người dùng bấm Vào ở bàn mới. |
| **T5** | Bấm **Thoát** | rời bàn | SẴN SÀNG / CHƯA SẴN SÀNG: trả vai trò. KEY: giữ vai trò (có thể Vào lại). |
| **T6** | *Bị server đá* | **không làm gì**; báo "BỊ ĐÁ · bấm ReJoin" | Vai trò giữ nguyên. |
| **T7** | *Bàn không còn* (Vào/ReJoin báo "Phòng không tồn tại") | giải tán nhóm | Báo "Bàn đã mất — bấm Tạo". |

## 2. Chế độ TỰ ĐỘNG — ô ☐ TỰ ĐỘNG ở cuối tool

Chỉ chạy khi ô **được tích**. Acc KEY = acc đầu tiên (thứ tự A, B, C) đang ở trong game.

| Mã | Tình huống | Tool làm (tuần tự, mỗi bước có nhịp) |
|---|---|---|
| **A1** | Tích ô, **chưa có nhóm** (cần chọn Tiền) | (1) từng acc đang ngồi bàn nào đó → rời bàn · (2) T1 cho acc KEY · (3) T2 cho acc thứ 2 (SẴN SÀNG) · (4) T2 cho acc thứ 3 (CHƯA SẴN SÀNG) · (5) kiểm tra cả nhóm cùng bàn |
| **A2** | Tích ô, **đã có nhóm** (tạo bằng tay) | Giữ nhóm. Acc của nhóm đang không ngồi → vào lại (T3). Acc đang ở game nhưng chưa trong nhóm → vào thêm (T2). |
| **A3** | Một acc **bị đá** | chờ nhịp → vào lại đúng bàn bằng key, giữ vai trò. Tối đa 5 lần/phút/acc; quá → dừng tự vào lại cho acc đó và báo lỗi. |
| **A4** | **Bàn không còn** (vào lại báo "Phòng không tồn tại") | làm lại A1 với cùng Tiền và cùng acc KEY. |
| **A5** | Bấm **Đổi Key** | làm lại A1 (mọi acc rời bàn cũ, tạo bàn mới key mới, gom lại). |
| **A6** | **Bỏ tích** ô | huỷ mọi việc tự động đang chờ; ghế giữ nguyên; nhóm giữ nguyên (tiếp tục bằng tay). |

## 3. Nút trên tool (dùng cho cả hai chế độ)

| Nút | Làm |
|---|---|
| THOÁT BÀN TẤT CẢ | Bỏ tích TỰ ĐỘNG; từng acc rời bàn (có nhịp); nhóm giải tán. |
| ĐÓNG TẤT CẢ | Như trên, rồi đóng 3 trình duyệt. |
| XẾP CỬA SỔ | Xếp lại 3 cửa sổ game. |

## 4. Không bao giờ

- Tự bấm **Bắt đầu** cho chủ bàn.
- Gửi token đăng nhập hoặc mã lấy từ bàn khác làm mật khẩu.
- Hai acc gửi lệnh cùng một lúc, hoặc gửi lệnh không có nhịp.
- Tự làm bất cứ việc gì khi ô TỰ ĐỘNG không tích (ngoài đúng nút người dùng bấm).

## 5. Đã bỏ khỏi tool (2026-09-21)

Luồng **TÌM BÀN theo danh sách sảnh** và mọi thứ đi kèm đã được gỡ: bằng chứng từ log Test D cho thấy hai acc
vào **cùng một số bàn** trong danh sách vẫn bị server xếp vào **hai bàn khác nhau**, nên luồng đó không bao giờ
gom được nhóm. Thay thế bằng T1 (tạo bàn) + T2 (vào theo số bàn).

Kéo theo đó, các phần sau cũng đã gỡ vì không còn đường nào chạm tới: bộ lọc bàn (`table-qualify`), khoá tìm bàn
(`find-lock`), máy trạng thái HOST/FOLLOWER cũ (acquireHost / joinFollowers / runDiscovery / recoverHost), hai
thí nghiệm join (`join-experiment`, `host-anchored-join`), `room-scanner`, `shared-room-session`,
`stake-catalog`, `phom-simulator-controller`, ô chọn "người tìm bàn" và bảng điều khiển thủ công cũ trong tool.
