# Tiến độ triển khai Phỏm — 2026-09-21

## Điều chỉnh theo xác nhận mới của người dùng

Mã chữ phải tự lấy từ WS/response, không yêu cầu người dùng biết hoặc import. Mục import Token Key đã được bỏ khỏi SETUP; module lưu key vẫn còn để tránh xóa dữ liệu cũ nhưng không được dùng trong flow JOIN.

Runtime hiện lấy `hpwd` dạng chuỗi trong TABLE_STATE của anchor và truyền vào password JOIN_SHARED. Đã thêm test chứng minh nguồn response này được ưu tiên hơn override thủ công; `hpwd` boolean trong list không phải mã chữ. Đây là hành vi code đã kiểm tra, chưa chứng minh `hpwd` chính là mã người dùng nói tới trong game thật.

Recorder bổ sung `roomEvidence` trong JSON: đường dẫn field, kiểu dữ liệu, cờ rỗng và HMAC tham chiếu. Cùng giá trị giữa response/JOIN trong một lần ghi có cùng tham chiếu; mỗi lần ghi dùng khóa ngẫu nhiên mới, không xuất khóa hoặc mã nguyên văn. Chỉ đối chiếu trường hpwd và password JOIN, không lập fingerprint token đăng nhập. File TXT vẫn là tóm tắt; phân tích mã dùng JSON đi kèm.

Kiểm tra mới nhất: 1.052 test offline pass, syntax renderer và whitespace check pass. Để có bằng chứng mới cần khởi động lại Phom QA với code mới rồi ghi một lượt vào bàn; capture cũ không thể khôi phục giá trị đã che.

## Đã tích hợp vào ứng dụng

- FIND lock toàn session dùng lease có ownership và AbortController; manual, group và các entry point legacy/experiment phải qua lock. STOP, disconnect, reload và cancel vô hiệu hóa operation tương ứng. Session cũ được stop khi thay session.
- FIND trên header và tool gọi `findAndJoinGroup` trong backend. FINDER tìm/join trước, xác minh membership và capacity, sau đó B2/B3 JOIN_SHARED tuần tự. Không còn vòng JOIN nhóm ở renderer/main.
- Sau JOIN, thiếu slot thì không publish thành công. Đã bỏ fallback dùng channel matchmaking trong discovery và fallback giữ bàn thiếu chỗ. Nếu người ngoài chiếm slot trong lúc JOIN nhóm, backend yêu cầu cả nhóm LEAVE và chờ xác nhận.
- CHANNEL_LIST không còn xóa tableState. LEAVE timeout giữ membership quan sát được, báo LEAVE_UNCONFIRMED và không JOIN tiếp. LEAVE ALL dùng kết quả xác nhận của từng browser, kể cả sau STOP.
- READY chỉ sau bằng chứng cùng bàn; giữ hai READY và một WAITING kể cả khi người thứ tư vào. Nếu browser WAITING đã READY thì báo cần bỏ sẵn sàng trong game, vì chưa có packet UNREADY đã xác minh. STOP hoặc round bắt đầu chặn READY tiếp.
- Log co-seat che raw frame, room code, binary preview và game probe trước emit/serialize. Header/snapshot chỉ chứa room code đã che. Recorder bổ sung che token đăng nhập dạng positional và identity id:1. Không dùng login session token làm room password dự phòng.
- SETUP có mục Token Key thu gọn: import TXT mỗi dòng một key hoặc JSON array chuỗi; bỏ trùng; bật/tắt; chỉ trả metadata đã che qua IPC. Lưu `phom/token-keys.enc` bằng Electron safeStorage, ghi file bất đồng bộ/atomic rename, không có fallback plaintext. Trạng thái quét chưa sẵn sàng được hiển thị rõ.
- Giữ một event stream cho Analyzer; không thêm lệnh đánh bài.

## Domain/scanner đã có nhưng chưa nối live

`StakeCatalog`, `TokenKeyPool`, `RoomScanner`, `SharedRoomSession` đã có unit test độc lập. Scanner tuần tự, round-robin, retry timeout một lần, cooldown, invalid key, Abort và kiểm tra scanId/attemptId trước khi chấp nhận response. SharedRoomSession chỉ publish sau xác nhận FINDER và kiểm tra slot/version/bet/RID.

Catalog production cố ý rỗng. Scanner từ chối chạy nếu chưa có catalog và adapter được xác nhận có correlation. Pool lưu trong ứng dụng chưa được sử dụng để gọi server. Không lấy monetary stake hoặc channel ID gán vào betId.

## Protocol reality check

Đã đọc cấu trúc của 1.070 frame từ file local:

`C:/Users/6006237/AppData/Roaming/Phom QA/phom-captures/test-D-2026-09-19T09-09-15-406Z.json`

Fixture chia sẻ an toàn: `tests/fixtures/phom/protocol-evidence.json`; chỉ có command/public metadata, tài khoản thay placeholder, không có token/password. Đây là trích xuất cấu trúc từ capture, không phải live test mới.

| Quan sát | Kết luận triển khai |
|---|---|
| Request CMD 300 có aid/cmd/gid; không có tokenKey | Chưa thể implement list-by-token transport |
| rs[] chứa Phom#0..Phom#13, channel 139..152 và mức tiền b | Không được gọi các ID đó là betId; qualifier loại Phom#N ngay cả khi uC thấp |
| Có các row `rn: Phom` và RID riêng trong list | Có nguồn candidate từ list; không chứng minh RID trong TABLE_STATE |
| TABLE_STATE cmd 202 có Mu/b/ps/hpwd/cP/gS… nhưng không có rid trong capture | Flow đang chạy xác minh UID/seat/player-set; chưa nghiệm thu tiêu chí ba explicit RID từ server |
| Request READY chỉ quan sát aRd=true | Không tự tạo packet UNREADY |
| Cùng capture có cmd 2011 chứa rs[] của game khác | Classifier đã chặn rs[] của command khác khỏi CHANNEL_LIST Phỏm |
| Response không chứng minh echo scanId/attemptId/tokenKey | Không gắn nhãn response cũ theo timestamp mới; adapter cần mapping có bằng chứng |

## Chưa hoàn thành theo toàn bộ plan

- Cần packet request/response quét bằng tokenKey và mapping betId cố định đã xác nhận. UI cược hiện tại vẫn dùng nguồn server của flow cũ; chưa chuyển sang catalog production.
- Chưa tích hợp SharedRoomSession mới vào protocol runtime hiện tại; chưa chuyển toàn bộ identifier sang kiểu domain riêng. Còn các API legacy/diagnostic, nhưng các intent FIND trên UI dùng backend group owner chung.
- Chưa đủ reconnect grace period/finder handover, cooldown RID theo session và toàn bộ ma trận 10 tình huống; logic hiện tại vẫn có cơ chế kick/rejoin và invalidation cũ được tái sử dụng.
- Chưa refactor toàn bộ UI sang patch từng card; chưa chuyển co-seat file logger sang async hoàn toàn; còn polling trên các đường legacy. Token store mới đã dùng async I/O.
- Chưa mở game/chạy live, chưa đo latency, chưa nghiệm thu 30–50 chu kỳ hoặc quay video. Không công bố hoàn tất Phase 0–8 chỉ từ test offline.

## Cần bổ sung để tiếp tục phần live

1. Capture có request thật sử dụng một tokenKey do người dùng cấu hình, kèm response danh sách tương ứng và cơ chế correlation.
2. Bảng nhãn cược ↔ betId có nguồn bằng chứng; không dùng các placeholder trong tài liệu.
3. Bằng chứng RID thực tế của TABLE_STATE/join ACK và request UNREADY nếu protocol hỗ trợ.

Không cần cấp lại quyền sửa code. Điểm chặn là thiếu dữ liệu protocol, không phải chờ phê duyệt.

## Kết quả kiểm tra offline

- 1.048 test Phỏm pass, 0 fail; loại các file live, proxy-auth và proxy-transport khỏi lần chạy này.
- Syntax check pass cho main, preload, coordinator, game header và renderer; git diff whitespace check pass với CRLF của repository.
- Header giữ trạng thái chưa xác nhận rời bàn và cho thử LEAVE lại; không hiển thị JOIN_SHARED trong trạng thái này.
- Đã bỏ tùy chọn UI lưu mã bàn nguyên văn; diagnostic log và trace che dữ liệu nhạy cảm trước khi phát ra.
- Chưa thực hiện live game hoặc xác minh Electron safeStorage trên phiên ứng dụng đang chạy; test persistence dùng bộ mã hóa có xác thực trong môi trường test.
