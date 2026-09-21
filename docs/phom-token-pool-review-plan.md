# Review và kế hoạch nâng cấp Phỏm

Ngày: 2026-09-21. Phạm vi: review working tree hiện tại theo tài liệu và sơ đồ người dùng cung cấp; chưa thay đổi implementation. Các nhận định trong tài liệu là yêu cầu thiết kế cần đối chiếu, không phải bằng chứng protocol. Repository có sẵn thay đổi chưa commit ở main/coordinator/session/header/UI/tests; review bao gồm các thay đổi đó và không ghi đè chúng.

## Kết luận

Flow mục tiêu hợp lý nhưng chưa đủ bằng chứng để triển khai scanner token lên server. Cần xác nhận riêng tokenKey dùng quét, token đăng nhập, room password, channelId, RID và betId. Code hiện tại không có TokenKeyPool/StakeCatalog theo hợp đồng mới; đang dùng CMD 300 lấy rs[], CMD 311 quick-find và op 3 join.

Không nên viết thêm một orchestration stack song song. Tách dần HostTableCoordinator thành domain services, giữ HostSessionManager làm adapter và chuyển mọi intent từ main/header/IPC về một owner.

## Phát hiện theo mức ưu tiên

1. **P1 — FIND chỉ khóa từng browser.** `host-table-coordinator.cjs:1024` kiểm tra `rec._discovering`, không có mutex toàn session tại entry point này. `phom-main.cjs:1546` vẫn expose manual-discover trực tiếp. Khi B1/B2 gọi cùng lúc, guard của B1 không khóa B2. Chọn finder hoặc disable nút không thay thế được khóa backend. Cần lock session, kiểm tra trước await đầu tiên, áp dụng cho mọi entry point kể cả legacy.
2. **P1 — Danh sách channel có thể xóa membership đang hợp lệ.** `phom-context.cjs:111–118` xóa tableState mỗi khi nhận CHANNEL_LIST. Response trễ sau JOIN có thể làm browser bị coi là đã ra lobby. Generation guard ở coroutine không chặn mutation này. Cần phân loại/correlate response trước reducer; chỉ clear membership trên bằng chứng rời bàn đã xác nhận.
3. **P1 — JOIN tiếp dù LEAVE chưa được xác nhận.** `host-table-coordinator.cjs:1397–1402` chỉ đợi cooldown nếu `lv.confirmed` false rồi vẫn join; `_leaveConfirmed:1261` và `manualLeave:1586` xóa state cục bộ cả khi timeout. Trái yêu cầu phải xác minh đã rời bàn khác. Giữ trạng thái UNKNOWN/LEAVE_UNCONFIRMED và phục hồi bằng protocol truth; không coi timeout là rời thành công.
4. **P1 — Log chứa token/key đầy đủ.** `host-table-coordinator.cjs:252–266`, `:846`, `:1695–1698` đưa raw frame, roomCode và sharedCode vào log luôn bật. `phom-main.cjs:182–183` stringify trước khi ghi file. Cần redact trước emit/IPC/serialize, chỉ dùng keyId và mask; kiểm tra cả binary preview và game probe. Không chỉ che phần UI.
5. **P1 — Có nhánh publish bàn không đủ chỗ.** `host-table-coordinator.cjs:1215–1225` trả FOUND, anchorValid=true dù fitsAll=false. Header hiện truyền minSeats=3 và noStakeFallback=true (`phom-main.cjs:974`), nhưng backend vẫn giữ fallback và entry point khác có defaults khác. Cần xóa fallback khỏi flow nhóm; candidate chỉ được publish khi còn đủ chỗ sau FINDER join.
6. **P2 — Nguồn cược và ý nghĩa key chưa đúng hợp đồng mới.** `_betOptionsFor:891` và `ui-phom/phom-qa.js:1221` lấy cược từ dữ liệu server. `_anchorRoomCode:1339` dùng session token làm fallback room code. `phom-wire.cjs:18` không có tham số tokenKey cho request list. Chưa chứng minh session token, room password và tokenKey trong tài liệu là cùng khái niệm; không được nối chúng bằng suy đoán.
7. **P2 — Ownership chưa thống nhất.** Legacy runDiscovery và manualDiscoverTable cùng tồn tại; main tự gọi autoJoinGroupToShared sau FIND (`phom-main.cjs:982`). Bản thân module orchestration cũ đã được tách bỏ theo `phom-wire.cjs`, nên nhận định “hai stack độc lập” trong tài liệu không hoàn toàn còn đúng. Vấn đề còn lại là nhiều đường điều khiển nghiệp vụ trong cùng hệ thống.

## Những phần nên giữ

- PhomContext, frame classifier và wire builders là nền để xây protocol adapter.
- manualJoinShared đã có retry giới hạn và xác minh membership cùng anchor.
- verifySameTable kiểm tra UID của cả nhóm, player-set fingerprint và seat consistency, không chỉ số người. Tuy nhiên đây chưa phải phép kiểm tra explicit RID của từng browser theo plan mới.
- WebSocket close đã được route: main:1154 → routeSocketClosed → markSocketClosed:303. Cần kiểm tra tiếp error event và recovery/grace period, không xây lại close handler từ đầu.
- Nhiều wait đã event-driven; vẫn còn polling trong acquireHost:357 và _followTogether:1886. Chỉ xóa sau khi xác định đường nào còn được sử dụng.
- Log đã batch 250 ms, nhưng còn appendFileSync trên main thread. Giữ batching, chuyển I/O bất đồng bộ và thêm redaction.
- Giữ profile/proxy/device/license, browser lifecycle, Analyzer/round history/Safe Cards; không thêm lệnh tự đánh.

## Điều chỉnh thiết kế trước triển khai

1. **Protocol gate:** lập bảng packet thực tế cho list-by-token, list response, explicit RID, bet ID, targeted join, leave ACK, ready/unready, reconnect và lỗi. Mỗi mapping phải có fixture đã che bí mật. Nếu protocol không hỗ trợ list-by-token như tài liệu, phải cập nhật thiết kế scanner; không tự chế packet.
2. **Tách credential:** thêm loginSessionToken và roomJoinCode nếu protocol chứng minh có chúng; không ép chúng vào tokenKey. SharedRoom chỉ chứa tokenKeyId, không chứa secret. channelId nằm trong context từng browser; chỉ coi là chung nếu bằng chứng cho phép.
3. **READY:** sơ đồ yêu cầu đủ ba browser trước READY, còn phần tình huống cho phép A+B READY trước C. Chọn mặc định chặt hơn: đủ ba membership/RID mới READY, hai READY và một WAITING. Bổ sung quyết định khi người thứ tư vào; chưa tự chuyển cả ba READY. Wire hiện chỉ có ready=true, cần xác nhận unready.
4. **STOP và LEAVE:** STOP hủy scan/join/retry/pending READY và đóng generation; LEAVE ALL là intent riêng. Lệnh đã gửi không thể thu hồi: response đến muộn vẫn cập nhật quan sát thực tế nhưng không được publish/tiếp tục phiên cũ.
5. **Reservation:** là khóa cục bộ, không đảm bảo server giữ ghế. Revalidate capacity sau mỗi membership event. Nếu bàn đã PLAYING và server không cho LEAVE ngay, ghi nhận pending leave/error thật, không báo cả nhóm đã rời.
6. **Stale response:** scanId/attemptId nội bộ chưa đủ nếu server không echo correlation. Phải xác minh khả năng ghép request/response; timeout rồi đổi key có thể nhận response của key trước. Không dùng timestamp mới đơn thuần làm bằng chứng response thuộc attempt hiện tại.

## Kế hoạch triển khai

| Bước | Thay đổi dự kiến | Điều kiện hoàn thành |
|---|---|---|
| 0 — Protocol reality check | Audit phom-wire, classifier, context; tạo fixtures đã redact và bảng evidence | Xác nhận tokenKey/list/RID/betId/join/leave/unready; ghi rõ phần chưa biết; không điền ID đoán |
| 1 — Domain và owner | Thêm stake-catalog.cjs, token-key-pool.cjs, shared-room-session.cjs, phom-coordinator.cjs; HostSessionManager làm adapter | Tách identifier bằng constructors/validation trong CJS; catalog cố định có provenance; session/version/expectedBrowsers bất biến trong lượt chạy |
| 2 — Scanner | Thêm room-scanner.cjs; mở rộng adapter theo packet đã xác nhận; sửa table-qualify | Quét tuần tự round-robin; timeout retry một lần; invalid/cooldown; lọc game/bet/slot/playing/cooldown; stale guard trước mutation; secrets không qua snapshot/log |
| 3 — FINDER reservation | Lock toàn session + AbortController; reserve candidate, join, xác minh, publish | Gọi FIND đồng thời từ B1/B2/header/IPC chỉ tạo một lượt; STOP giải phóng lock đúng owner; không publish candidate chưa xác nhận hoặc thiếu chỗ |
| 4 — JOIN_SHARED | Chuyển autoJoinGroupToShared từ main vào coordinator; dùng SharedRoom version | B2 rồi B3 join đúng đích, không discovery; xác nhận leave bàn cũ; chống đổi RID giữa các await; từng membership được chứng minh |
| 5 — Slot/READY/reconnect | ReadyCoordinator và ReconnectCoordinator hoặc services tương đương | Đủ 10 tình huống trong tài liệu; thiếu slot thì hủy nhóm; grace period finder; rejoin cùng phiên; không tự đánh; không giả định gửi leave là thành công |
| 6 — UI | Sửa ui-phom/index.html, phom-qa.js/css, game-header, preload/main IPC | Hai tab; một stake selector theo phiên; token manager masked; snapshot/action chung; card/header chỉ gửi intent; không tự orchestration |
| 7 — Cleanup và performance | Xóa entry points legacy sau migration; async log; patch UI; bỏ polling critical path | Một owner, một CDP owner/browser; không tác động Analyzer; đo p50/p95/max cho event→coordinator→UI và chuyển token |
| 8 — Live verification | Kịch bản có kiểm soát + log đã redact + video | FIND→JOIN→READY/WAITING→REJOIN→LEAVE; STOP giữa scan/join; response cũ; 30–50 chu kỳ; round N→N+1; nghiệm thu theo bằng chứng |

Thứ tự phụ thuộc: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Có thể dựng UI bằng snapshot giả sau bước 1, nhưng chưa bật action server trước protocol gate. Redaction nên làm trước capture mới. Mỗi bước là một thay đổi có test riêng; tránh rewrite toàn bộ coordinator trong một lần.

## Kiểm thử và baseline

Đã chạy offline tám file: phom-table-qualify, phom-ws-disconnect, phom-find-hygiene, phom-coseat-key-refresh, phom-bet-options, phom-host-session-manager, phom-find-wiring, phom-real-protocol. Kết quả: **97 pass, 0 fail, 0 skip**, khoảng 12 giây. Đây là baseline của hành vi hiện tại, không chứng minh flow token pool hay protocol live đúng.

Regression bổ sung khi triển khai: FIND đồng thời trên nhiều browser; STOP rồi FIND mới trước response cũ; CHANNEL_LIST đến sau TABLE_STATE; LEAVE timeout không được JOIN tiếp; cùng RID nhưng khác version; slot bị chiếm sau reservation; finder disconnect khi follower còn trong bàn; all-keys cooldown; token lỗi schema; bí mật không xuất hiện trong logs/snapshot/IPC; bảo toàn Analyzer và lifecycle profiles.

Chưa chạy live, chưa mở Chromium, chưa kiểm tra video gốc và chưa xác nhận bet IDs/token scanning packet. Chỉ có sơ đồ và tài liệu đính kèm làm yêu cầu đầu vào.
