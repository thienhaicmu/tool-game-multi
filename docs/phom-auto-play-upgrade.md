# Tự đánh: quy tắc sau nâng cấp

Hai nhánh cạ ù và nuôi ít tiền chỉ áp dụng khi người ngồi ngay sau là UID của acc trong tool đang chơi trong ván. Chặn ăn lần 3 áp dụng với mọi người ngồi sau (2026-10-10): acc tool chặn chính xác theo bài; người ngoài chỉ biết thông tin công khai nên chỉ lá chắc chắn không bị ăn mới được coi là chặn được. Còn lại, người ngoài dùng thứ tự đánh bình thường. Các acc trong tool có thể chia sẻ bài để chọn lá hỗ trợ; gợi ý bấm tay vẫn dùng bài riêng và thông tin công khai.

Thứ tự: đúng luật → chặn ăn lần 3 → cạ ù hợp lệ → nuôi ít tiền → mặc định. Chặn ăn lần 3 luôn bật, không ngoại lệ cạ ù, kể cả cấu hình cũ ghi false. Hai tùy chọn còn lại dùng chung cho các acc bật Tự đánh.

Tiền được đọc từ snapshot trình duyệt theo profileId/UID. Tiền null/rỗng/âm không được coi là 0. So sánh trong các acc thuộc tool đang tham gia ván, không so với người ngoài; nếu một thành viên thiếu tiền thì bỏ nhánh nuôi. Đồng tiền thấp nhất vẫn có thể được hỗ trợ nếu ngồi ngay sau. Chưa có timestamp tiền từ nguồn nên chưa thể xác minh độ mới độc lập; số tiền dùng là giá trị mới nhất coordinator cung cấp.

Cạ ù cần một cách xếp chứa ít nhất 9 lá trong các phỏm, tối đa một lá rác để đánh, mọi lá ăn trên tay được giữ trong phỏm, mỗi phỏm tối đa một lá ăn. Không nhận việc chỉ tăng số phỏm là ù. Máy chủ vẫn quyết định luật và kết quả ù cuối cùng.

Chặn ăn kiểm tra các cách xếp hợp lệ của bài người sau. Khi không còn lá tránh ăn hợp lệ, vẫn đánh phương án mặc định và báo không có lá tránh; không treo lượt. Khi chưa biết bài người sau, không thể chứng minh chặn tuyệt đối. Lượt hạ và lượt gửi cũng chọn lá cuối có xét chặn.

Mỗi acc chỉ có một thao tác đang chạy; vòng kiểm tra không chờ trình duyệt chậm của acc khác. Nước chờ được tính lại khi bài/phỏm công khai/thứ tự lượt/tùy chọn/tiền đổi. Một nước đã gửi phải được xác nhận bằng lịch sử tương ứng của chính acc, không bởi thay đổi khác trên bàn. Hết thời hạn chưa xác nhận thì dừng, riêng Ăn có thể chuyển Bốc nếu game còn cho phép. Tắt rồi bật lại tạo phiên chạy mới để bỏ kết quả probe cũ.

So sánh Ăn/Bốc dùng điểm rác thấp nhất sau khi lấy rồi đánh một lá, có ràng buộc lá ăn. Điểm Bốc là trung bình trên các lá chưa biết từ bài riêng và thông tin công khai, giả định đồng đều; đây là ước lượng, không phải xác suất thắng hay mô hình phân bố nọc đã kiểm chứng. Bộ chọn lá cho lượt trước lượt cuối trong nhánh acc tool đánh giá số cửa hoàn thiện cạ và số lượt còn lại, vẫn ưu tiên giữ phỏm và mức an toàn trước điểm dự kiến. Kết quả xếp phỏm được cache tối đa 128 bộ bài; bản sao được trả về để tránh nước sau bị ảnh hưởng bởi sửa mảng ở nước trước.

Log coseat.jsonl luôn ghi auto-play-decision, auto-play-step, auto-play-confirmed và bật/tắt. Decision chứa snapshot bài, tùy chọn, nút được game cho phép, nước chọn và lý do. Không có dữ liệu đăng nhập; log vẫn chứa bài/UID/tiền như các log chẩn đoán của tool.

Replay chỉ đọc log, không kết nối game:

```powershell
node tools/phom-auto-play-replay.mjs <đường-dẫn-coseat.jsonl>
```

Công cụ đối chiếu nước đã ghi với bộ chọn nước hiện tại. Không suy ra kết quả thắng/thua từ replay vì quyết định khác sẽ làm diễn biến ván khác. Cần ván thật để đánh giá điểm rác, móm, ù và kiểm chứng tất cả bước Ăn/Bốc/Hạ/Gửi/Đánh/Ù.

## Mô phỏng (GĐ3 · S4, 2026-10-10)

`tools/phom-sim` chơi ván offline bằng đúng bộ đọc bài (`phom-card-observer`) và bộ chọn nước (`phom-auto-play nextStep`)
của tool, với một engine luật (`engine.cjs`) và bảng tính tiền theo cược: nhì/ba/bét 1/2/3, móm 4, bị ăn 1, ăn chốt 4,
ù 5 mỗi người, đền = người cho ăn lá thứ 3 trả thay cả bàn. Bảng này chưa đối chiếu với gói 855 thật (GĐ4).

```powershell
node tools/phom-sim/run.mjs --rounds 3000 --seed 7 --seats TTTL --outsider-ref 0a0fa30 --out after.json
node tools/phom-sim/compare.mjs before.json after.json
```

`T` = acc tool (chia sẻ bài với các T khác), `L` = acc lạ (bài riêng + công khai, kịch bản bình thường). `--outsider-ref`
giữ acc lạ ở bộ chọn nước của một commit đã phát hành — nếu không, thay đổi áp cho cả hai phía và không đo được lợi của
nhóm tool. Vòng chia mặc định cố định (ván r bắt đầu ở ghế r mod n) để hai phiên bản chơi **cùng bộ bài, cùng ghế** và
so theo cặp từng ván. Không mô phỏng: ù khan, "chuyển bài" sau khi ăn, hết nọc. Acc lạ trong mô phỏng là bot đánh như
kịch bản bình thường — người thật có thể khác.
