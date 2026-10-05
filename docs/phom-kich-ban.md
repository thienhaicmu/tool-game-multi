# Phỏm — Kịch bản bàn chơi (Tay & Tự động)

Tài liệu này là **đặc tả**. Module `desktop/protocol/phom/table-group.cjs` làm đúng từng bước dưới đây; test
`tests/js/phom-table-group.test.mjs` đặt tên theo mã kịch bản (T1, A3…).

## 0. Quy tắc chung

| Quy tắc | Nội dung |
|---|---|
| Vai trò | Theo **thứ tự thao tác** (không theo số acc): acc bấm **Dò Key** = **KEY** (chủ bàn; chỉ tự bấm **Bắt đầu** khi bàn đủ 4 người và mọi người khác đã sẵn sàng — xem T8). Acc **ngồi vào bàn KEY thứ nhất** (Tạo hoặc Vào) = **SẴN SÀNG**. Acc **ngồi vào thứ hai** = **CHƯA SẴN SÀNG** (bị đá ~10 giây/lần vì chưa sẵn sàng; **tự vào lại chỉ khi bấm ReJoin hoặc tích TỰ ĐỘNG** — sau ~0,5 giây). Ba acc độc lập cho tới khi một acc bấm Dò Key. |
| Vai trò giữ nguyên | Vai trò gắn với acc cho tới khi nhóm giải tán. Bị đá rồi vào lại vẫn giữ vai trò cũ. |
| Bàn | Bàn của nhóm là **một bàn công khai trống** mà acc KEY ngồi vào **một mình** (Dò Key). Người chơi khác vào được — đó là mục đích. Tool **không tạo bàn riêng** (308 bắt buộc có mật khẩu nên không ai vào được). |
| Mức cược | Luôn là mức **Tiền chọn ở tool Phỏm** (Dò Key dùng mức đó; Tạo dùng đúng mức acc KEY đang ngồi). Thanh trong trình duyệt không có ô chọn cược. |
| Số bàn | Máy chủ **không bao giờ** báo số bàn cho acc KEY (gói 202 không có số bàn). Số bàn (SS) chỉ có khi một acc khác **Tạo** dò ra bàn của KEY; từ đó SS tự điền vào mọi trình duyệt. |
| Nhịp | Trước **mỗi** lệnh gửi lên server: chờ **ngẫu nhiên 0,8–2,5 giây**. |
| Mỗi acc một việc | Mỗi acc chỉ chạy **một thao tác tại một thời điểm**, dù yêu cầu đến từ thanh trong trình duyệt, từ tool hay từ timer. Yêu cầu thứ hai cho acc đang bận bị từ chối kèm lý do ("Acc này đang Tạo — đợi xong hoặc bấm Dừng"). **Thoát** thì luôn được nhận. |
| Tay = độc lập | Chế độ TAY: các acc chạy **độc lập** — Dò Key lâu ở acc này không bắt Vào ở acc khác phải chờ. Nhiều acc được bấm Tạo **cùng lúc**; acc nào tìm ra bàn KEY trước thì ngồi trước, các acc còn đang dò dừng lại và Vào số bàn đó. |
| Tự động = đồng bộ | Chế độ TỰ ĐỘNG: mọi thao tác chạy trong **một hàng đợi tuần tự**, không thao tác nào chen vào thao tác đang chạy. Trong lúc đó **các nút bàn trên thanh bị khoá**, thanh hiện chip **TỰ ĐỘNG · đang …**; muốn bấm tay thì bỏ tích ô Tự động (luật D1). Bấm muộn (thanh chưa kịp vẽ lại) cũng bị từ chối. |
| Dò Key khi đã có nhóm | Nhóm còn thành viên thì **không bị thay âm thầm**: lần bấm đầu báo "Đang có nhóm… bấm Dò Key lần nữa trong 5 giây để huỷ nhóm cũ"; bấm lần hai trong 5 giây mới lập nhóm mới (luật D2). KEY đang ngồi thì acc khác **không** được Dò Key (tránh tách 2 bàn). |
| Trạng thái | Mỗi acc có **một trạng thái duy nhất** (`browser-state.cjs`); thanh trong trình duyệt và thẻ P1/P2/P3 của tool hiện **cùng một chữ**. Lỗi hiện trên thanh tự xoá khi trạng thái acc đổi. |
| Sẵn sàng | Như tool đối thủ: "tự sẵn sàng" (lệnh 363) **luôn tắt** cho cả 3 acc. Acc SẴN SÀNG bấm sẵn sàng bằng `[5,"Simms",-1,{cmd:5}]` **khi acc CHƯA SẴN SÀNG đã ngồi** (log 2026-10-03: bàn chỉ có KEY + 1 acc sẵn sàng thì ~16 giây sau server đá chủ bàn vì không bấm Bắt đầu), và **tự sẵn sàng lại sau mỗi ván**. |
| Cùng bàn | Một acc chỉ được tính "đã vào bàn nhóm" khi chính bàn của nó có acc KEY. |

Giao thức — lấy từ **log WS thật của tool đối thủ**, 3 trình duyệt ghi cùng lúc rồi ghép theo giờ
(`D:\demo\wtr_v.hitclub.guitars_20261002-222424 / 222702 / 222803.json`, 2026-10-02):

| Việc | Gửi | Nhận |
|---|---|---|
| Dò Key (chơi nhanh vào kênh cược) | `[3,"Simms",<kênh, vd 145>,"",true]` | `[3,true,0,-1,null]` + `[5,{ps:[…],cmd:202}]` |
| Hỏi bàn (Tạo) | `[6,"Simms","channelPlugin",{cmd:313,gid:8,aid:1,b:<cược>}]` | `[5,{ri:{rid,b,Mu,uC,hpwd,rn,…},cmd:313}]` hoặc `{mgs:"Không tìm thấy phòng thích hợp!"}` |
| Dò bằng mật khẩu vô hình | `[3,"Simms",<số bàn>,"\u200B"]` | luôn `[3,false,103,<số bàn>,"Sai mật khẩu phòng"]` |
| **Vào đúng bàn** (Vào / ReJoin / Tạo) | `[8,"Simms",<số bàn>,"",8]` | `[3,true,0,-1,null]` + `202` của chính bàn đó |
| Sẵn sàng | `[5,"Simms",-1,{cmd:5}]` (-1 = bàn đang ngồi) | `[5,{uid,cmd:5}]` |
| Tự sẵn sàng | `[6,"Simms","channelPlugin",{cmd:363,aRd:"true"\|"false"}]` | — |
| Rời bàn | `[4,"Simms",-1]` | `[4,true,1,-1,0,""]` |
| Bị đá | — | `[4,true,2,-1,2,"Bạn bị kick vì không sẵn sàng"]` (acc CHƯA SS: khoảng 10 giây/lần) |
| Người khác rời / vào | — | `[5,{p:{uid,…},t:2,cmd:200}]` / `t:1` |

Điều rút ra từ log:

1. **op 8 mới là "vào đúng bàn này"**. op 3 gửi tới số bàn không phải lệnh đó — đây là lý do lỗi 09-21 (hai acc cùng
   vào một số bàn bằng op 3 thì mỗi acc thành chủ một bàn mới).
2. Trả lời `313` chỉ **gọi tên** một bàn (rid + `uC` đang ngồi), không xếp chỗ. Tool đối thủ trả lời mọi bàn được gọi
   tên bằng một lệnh vào với mật khẩu `\u200B` để **chắc chắn bị từ chối** — nên acc không bao giờ ngồi nhầm bàn người
   lạ. Bàn có **đúng 1 người** có thể là acc KEY đang ngồi một mình → vào thật bằng op 8.
3. Bàn `rn` có `#` (vd `"Phom#6"`, rid nhỏ) là **kênh cược**, không phải số bàn.
4. Acc CHƯA SẴN SÀNG bị đá khoảng 10 giây/lần; tool đối thủ vào lại ngay (op 8) **mỗi lần** — trong log là 9 lần liên tiếp.

## 0b. Mỗi nút để làm gì (thanh trên mỗi trình duyệt — giống tool đối thủ)

Thanh: `P1 · tên-tiền · ID` · `SS [số bàn]` · **Copy · Vào · ReJoin · Tạo · Dò Key · Thoát**. Nút đang chạy có dấu chấm
(**Dò Key.**, **Tạo.**, **ReJoin.**, **Vào.**); bấm lại nút có dấu chấm để dừng. Dòng **ngay dưới** thanh: `ID Bàn · Số người ·
vai trò · cược` và mọi người trong bàn dạng `👑tên-tiền ✓` (acc của tool in đậm, người lạ in mờ).

| Nút | Bấm ở acc nào | Để làm gì |
|---|---|---|
| **Dò Key** | **MỘT** acc duy nhất | Tạo "chìa khoá" cho nhóm: acc này vào kênh cược, gặp bàn có người lạ thì rời, cho tới khi **ngồi một mình** ở một bàn trống → thành **KEY** (chủ bàn). Lúc này chưa ai biết số bàn — kể cả KEY (server không báo). Đã có KEY đang ngồi thì acc khác bấm Dò Key sẽ bị từ chối (tránh tách nhóm ra 2 bàn). |
| **Tạo** | Các acc **còn lại** (bấm cùng lúc được) | **Tìm ra số bàn của KEY**: hỏi server bàn trống liên tục, chỉ vào thử bàn có đúng 1 người, giữ lại nếu người đó là KEY. Tìm thấy → ngồi vào, số bàn (SS) tự điền vào mọi trình duyệt. |
| **Vào** | Acc nào cũng được, khi ô SS đã có số | Vào **đúng số bàn trong ô SS** (op 8). Dùng cho acc thứ 3, hoặc vào lại bằng tay. |
| **ReJoin** | Bất kỳ (bấm tay; TỰ ĐỘNG tích thì tự bật) | Công tắc: **bật** = bị server đá (vd "không sẵn sàng", ~10 giây/lần) thì **tự vào lại sau ~0,5 giây**. Bấm lại để tắt. Không bấm và không tích TỰ ĐỘNG → bị đá chỉ được báo. |
| **Lọc Bài** | Bất kỳ | Bật/tắt khung dưới thanh: lá **NÊN ĐÁNH / CÓ THỂ / ĐỪNG ĐÁNH / TRONG PHỎM** của **chính acc đó** (người đánh sau không ăn được) + **số lá còn lại** — cùng dữ liệu với tab PHỎM của tool Phỏm QA. |
| **Thoát** | Bất kỳ | Rời bàn (không tắt trình duyệt). Tắt ReJoin của acc đó. |
| **Copy** | Bất kỳ | Copy số bàn trong ô SS. |

Thứ tự chuẩn: **acc 1 Dò Key** (KEY) → **acc 2 Tạo** (ra SS, ngồi thứ nhất = SẴN SÀNG) → **acc 3 Vào** (ngồi thứ hai = CHƯA SẴN SÀNG — bấm **ReJoin** cho acc này, hoặc tích TỰ ĐỘNG) → người lạ vào ghế 4 và **sẵn sàng** (🔔 chuông 4 hồi) → **2–3 giây (ngẫu nhiên) sau acc 3 tự sẵn sàng** → **KEY tự bắt đầu ván**. Hoặc acc 2 + acc 3 cùng bấm **Tạo** (ai tìm thấy trước là SẴN SÀNG). Bước đủ 4 người → sẵn sàng → bắt đầu chạy ở cả chế độ TAY lẫn TỰ ĐỘNG.

## 1. Chế độ TAY — thanh công cụ trong từng trình duyệt

Ô ☐ TỰ ĐỘNG trên tool **không tích**. Tool chỉ làm đúng nút người dùng bấm, **không tự làm gì thêm**.

| Mã | Người dùng | Tool làm (theo thứ tự, mỗi bước có nhịp) | Kết quả |
|---|---|---|---|
| **T1** | Bấm **Dò Key** | (1) nếu acc đang ngồi bàn khác → rời bàn · (2) tắt "tự sẵn sàng" · (3) chơi nhanh vào **kênh của mức cược chọn ở tool** (`[3,…,<kênh>,"",true]`) · (4) bàn đã có người lạ → rời, chơi nhanh lại · (5) lặp tới khi **ngồi một mình** (là chủ bàn) · tối đa **3 phút** · bấm **Dừng** để thôi | Acc = **KEY**, ngồi một mình. Chưa có số bàn (thanh hiện KÊNH). Nhóm cũ (nếu có) giải tán. |
| **T2a** | Bấm **Tạo** (ở acc KHÁC acc KEY, sau khi KEY đã ngồi) | (1) rời bàn đang ngồi · (2) tắt "tự sẵn sàng" · (2a) **KEY không ngồi** (bị đá — bàn đã mất — hoặc đang Dò Key lại) → **chờ, không hỏi 313**; KEY ngồi lại thì tìm tiếp đúng bàn mới · (2b) **đường nhanh**: nếu đã nhận **danh sách bàn** (server phát ~60 giây/lần) **sau lúc KEY ngồi**, vào thẳng (op 8) các bàn **đúng cược · 1 người · không khoá**, **số bàn lớn nhất trước** (bàn mới nhất — bàn của KEY), có KEY → xong, không → rời, thử bàn kế (tối đa 6 bàn); chưa có danh sách mới thì làm bước 3 · (3) hỏi **313** — **một acc rút thăm một lúc**, tất cả các acc cộng lại **tối đa 15 lần/phút** (mỗi lần = 1 lần vào bàn sai mật khẩu; log 2026-10-05: ~60 lần/phút trong 10 phút → acc bị đăng xuất) — game **tự gửi lệnh vào bàn** đó `[3,"Simms",<số bàn>,""]` ngay khi nhận trả lời; tool **sửa chính lệnh đó** sang mật khẩu `​` (giống tool đối thủ) nên bị từ chối 103 — acc **không bao giờ ngồi vào bàn người lạ, tự sẵn sàng rồi đánh luôn** · (4) bàn được gọi tên → tool cũng vào thử bằng mật khẩu `\u200B` (luôn bị từ chối) · (5) bàn **đúng 1 người** → vào thật bằng **op 8** · (6) bàn đó có acc KEY → xong; **không có KEY** → rời ngay, hỏi tiếp · tối đa **3 phút** · bấm lại **Tạo.** để dừng · (7) nhận vai trò lúc ngồi vào: chưa ai SẴN SÀNG → SẴN SÀNG, còn lại → CHƯA SẴN SÀNG (ReJoin chỉ bật khi bấm nút hoặc tích TỰ ĐỘNG) | Số bàn của KEY = **SS của nhóm**, tự điền vào ô SS mọi trình duyệt. Các acc đang Tạo cùng lúc dừng và Vào số bàn đó. Đã có SS thì Tạo = Vào. |
| **T2** | Ô SS = số bàn nhóm, bấm **Vào** | nhận vai trò (như T2a bước 7) · rời bàn đang ngồi · đặt "tự sẵn sàng" theo vai trò · vào đúng số bàn bằng **op 8** · bàn đó phải có acc KEY (không có → rời) · SẴN SÀNG: bấm sẵn sàng | Ô SS **không bao giờ** chứa số kênh cược (log 2026-10-03: KEY ngồi qua kênh 139, ô SS hiện 139, Vào bị từ chối mã 166). Vào lỗi → trả lại vai trò. |
| **T2b** | Ô SS = số bàn **khác** nhóm, bấm **Vào** | vào bàn với mật khẩu rỗng (như bấm bàn trong sảnh) | Không có vai trò. |
| **T3** | Bấm **ReJoin** (công tắc) | **Bật**: vào lại bàn nhóm (như T2, giữ vai trò) và từ đó **mỗi lần bị đá tự vào lại ngay**, kể cả khi TỰ ĐỘNG không tích. Bấm lần nữa khi đang ngồi → **tắt** (vẫn ngồi). | Nút hiện "ReJoin ●" khi bật. Thoát bàn thì tắt. |
| **T4** | Bấm **Bàn khác** (acc KEY) | như T1: rời bàn, Dò Key bàn trống mới | Các acc khác **không** tự chuyển; người dùng bấm Tạo / Vào ở bàn mới. |
| **T5** | Bấm **Thoát** | rời bàn | SẴN SÀNG / CHƯA SẴN SÀNG: trả vai trò. KEY: giữ vai trò (có thể Vào lại). |
| **T6** | *Bị server đá*, ReJoin **tắt** | **không làm gì**; báo "BỊ ĐÁ · bấm ReJoin" | Vai trò giữ nguyên. (ReJoin **bật** → như A3.) |
| **T7** | *Bàn không còn* (Vào/ReJoin báo "Phòng không tồn tại") | giải tán nhóm | Báo "Bàn đã mất — bấm Tìm bàn". |
| **T8** | *Bàn nhóm đủ 4 người* (chưa vào ván) | (1) acc CHƯA SẴN SÀNG **chờ** · (2) **người lạ sẵn sàng** → 🔔 chuông **4 hồi** · **2–3 giây ngẫu nhiên** sau, acc **CHƯA SẴN SÀNG** tự bấm sẵn sàng · (3) khi **mọi người trừ chủ bàn đã sẵn sàng** → acc **KEY tự bắt đầu ván** (cùng lệnh cmd 5, chủ bàn gửi = Bắt đầu) · mỗi bước một lần mỗi ván; reset khi hết ván hoặc bàn hụt người | Chạy ở cả TAY và TỰ ĐỘNG. Người lạ chưa sẵn sàng thì KEY chờ. |

## 2. Chế độ TỰ ĐỘNG — ô ☐ TỰ ĐỘNG ở cuối tool

Chỉ chạy khi ô **được tích**. Acc KEY = acc đầu tiên (thứ tự A, B, C) đang ở trong game.

| Mã | Tình huống | Tool làm (tuần tự, mỗi bước có nhịp) |
|---|---|---|
| **A1** | Tích ô, **chưa có nhóm** (cần chọn Tiền) | (1) từng acc đang ngồi bàn nào đó → rời bàn · (2) T1 (Dò Key) cho acc KEY · (3) T2a (Tạo) cho acc thứ 2 (SẴN SÀNG) — ra số bàn · (4) T2 (Vào) cho acc thứ 3 (CHƯA SẴN SÀNG) · (5) bật **ReJoin** cho acc SẴN SÀNG và CHƯA SẴN SÀNG · (6) acc SẴN SÀNG bấm sẵn sàng · người thứ 4 sẵn sàng → 🔔 (bước bấm tay giống chế độ tay) — đúng những nút người dùng sẽ bấm tay, cùng nhịp |
| **A2** | Tích ô, **đã có nhóm** (tạo bằng tay) | Giữ nhóm. Acc của nhóm đang không ngồi → vào lại. Acc đang ở game nhưng chưa trong nhóm → Tạo (chưa có số bàn) hoặc Vào. |
| **A3** | Một acc **bị đá** (TỰ ĐỘNG tích, hoặc ReJoin của acc đó bật) | sau **~0,5 giây** — không xếp hàng, không chờ nhịp, không gửi lại 363 (log 2026-10-03: kiểu cũ mất ~8 giây) — vào lại đúng số bàn (op 8), giữ vai trò. **Mỗi lần**, không giới hạn (acc CHƯA SẴN SÀNG bị đá ~10 giây/lần là bình thường). Chỉ dừng khi bàn không còn (A4). |
| **A4** | **Bàn không còn** (vào lại báo "Phòng không tồn tại") | làm lại A1 với cùng Tiền và cùng acc KEY (Dò Key bàn trống mới). |
| **A5** | Bấm **Bàn khác** | làm lại A1 (mọi acc rời bàn cũ, Dò Key bàn trống mới, gom lại). |
| **A6** | **Bỏ tích** ô | huỷ mọi việc tự động đang chờ; tắt các ReJoin mà TỰ ĐỘNG đã bật (ReJoin người dùng tự bật thì giữ); ghế giữ nguyên; nhóm giữ nguyên (tiếp tục bằng tay). |

## 2b. Thay acc — P4 / P5 dự bị

Tick **3–5 profile** ở tab Profile: 3 profile đầu chơi ở **P1 · P2 · P3**; profile 4 / 5 mở làm **dự bị** — cửa sổ nằm
**đúng chỗ tool Phỏm, phía sau tool**. Dự bị **chạy nóng**: tool tự VÀO GAME cho nó, thanh trên trình duyệt có **đủ nút
như acc đang chơi** (ghi "DỰ BỊ P4 · …"). Dự bị **không** thuộc nhóm: TỰ ĐỘNG không bao giờ cho dự bị ngồi bàn, Lọc bài chỉ
tính P1–P3, và bài / ván ở bàn khác của dự bị không lẫn vào bàn nhóm. Trong ô chọn **Đổi**, mỗi dự bị kèm trạng thái
("ở sảnh" = đổi vào là ngồi ngay).

| Mã | Khi | Tool làm, theo thứ tự |
|---|---|---|
| **R1** | Bấm **Đổi** trên thẻ P1/P2/P3 (chọn P4/P5 dự bị) | (1) acc đang chơi ở ô đó **rời bàn** (op 4, chờ server xác nhận — trình duyệt này vẫn mở, không được giữ ghế) · (2) đổi chỗ: trình duyệt dự bị vào ô, cửa sổ chuyển vào vị trí ô; trình duyệt cũ lui ra sau tool, thành dự bị · (3) làm R3 |
| **R2** | Trình duyệt **đang chơi bị tắt trực tiếp** (đóng cửa sổ Chromium) | dự bị đầu tiên còn mở — **P4 trước, rồi P5** — tự vào ô đó (R1 bước 2–3). Tắt bằng nút trong tool (⏻, Thay profile, Đóng tất cả) thì **không** tự thay. |
| **R3** | Sau R1 / R2 / mở profile mới vào ô đã tắt | (1) acc mới **nhận đúng vai** của acc cũ (SẴN SÀNG / CHƯA SẴN SÀNG) và **trạng thái ReJoin** của ô · (2) **Lọc bài** của ô chuyển sang acc mới ngay; acc cũ thành người lạ · (3) chờ acc mới **vào game** (kiểm tra mỗi giây, tối đa 2 phút) → **Vào** số bàn nhóm (op 8), hoặc **Tạo** nếu chưa có số bàn · (4) kiểm tra sẵn sàng như sau mỗi lần vào bàn |
| **R4** | Acc bị thay là **KEY** | bàn mất chủ → **giải tán nhóm**. TỰ ĐỘNG tích → acc mới vào game xong thì **lập nhóm mới** (A1) với acc mới làm KEY. Không tích → báo; bấm Dò Key tay. |
| **R5** | Acc mới chưa vào game sau 2 phút | báo "chưa vào game"; đăng nhập rồi bấm Tạo / Vào tay. |

## 3. Nút trên tool (dùng cho cả hai chế độ)

| Nút | Làm |
|---|---|
| MỨC CƯỢC | Mức cược duy nhất của phiên; Dò Key / Tạo trên mọi thanh dùng mức này. |
| ☐ TỰ ĐỘNG | Tích = tool tự lập và giữ bàn (mục 2), các nút bàn trên thanh bị khoá. Bỏ tích = về chế độ tay, ghế giữ nguyên. |
| ☐ ẨN DANH | Mặc định **tắt**: số bàn thật, không có người chơi giả, thấy chat/bài/hiệu ứng. Bật = chế độ ẩn danh của game (từ bàn/ván sau). |
| ĐỔI (trên thẻ P1/P2/P3) | Chọn dự bị P4/P5 → đổi ngay (mục 2b, R1). Ô đã tắt: chọn dự bị hoặc một profile chưa mở → **Mở**. |
| BÀN KHÁC | Acc KEY Dò Key bàn trống mới (TỰ ĐỘNG: cả nhóm chuyển theo). |
| THOÁT BÀN TẤT CẢ | Bỏ tích TỰ ĐỘNG; từng acc rời bàn (có nhịp); nhóm giải tán; huỷ mọi lệnh vào lại đang chờ. |
| ĐÓNG TẤT CẢ | Như trên, rồi đóng mọi trình duyệt (cả dự bị). Không kích hoạt tự thay acc. |
| XẾP CỬA SỔ | Xếp lại cửa sổ game; tool luôn nằm trên các cửa sổ dự bị. |

## 4. Không bao giờ

- Tự bấm **Bắt đầu** cho chủ bàn khi bàn **chưa đủ 4 người** hoặc còn người chưa sẵn sàng (T8 là trường hợp duy nhất).
- **Tạo bàn riêng** (308) hay tự sinh mật khẩu bàn: bàn như vậy người chơi khác không vào được từ sảnh.
- Lấy số bàn từ một dòng trong danh sách sảnh rồi coi đó là bàn của nhóm (xem §5).
- Ngồi lại ở bàn người lạ khi đang Tạo: bàn vào thật mà không có acc KEY → rời ngay.
- Vào một số bàn bằng op 3 (đó là lệnh vào kênh / dò mật khẩu, không phải "vào đúng bàn").
- Gửi token đăng nhập hoặc mã lấy từ bàn khác làm mật khẩu.
- Trong TỰ ĐỘNG: hai acc gửi lệnh cùng một lúc. Ở mọi chế độ: một acc chạy hai việc cùng lúc, hay gửi lệnh không có
  nhịp — ngoại lệ duy nhất là **vào lại sau khi bị đá** (~0,5 giây, giống tool đối thủ).
- Tự làm việc bàn khi ô TỰ ĐỘNG không tích, ngoài: đúng nút người dùng bấm · vào lại của acc **đã bấm ReJoin** · VÀO GAME
  sau khi đăng nhập · quy trình thay acc R1–R5 (do người dùng bấm Đổi hoặc tự đóng cửa sổ đang chơi).
- Thay một nhóm còn thành viên mà không hỏi (Dò Key lần hai trong 5 giây mới huỷ nhóm cũ).
- Cho dự bị (P4/P5) ngồi bàn khi TỰ ĐỘNG, hay để bài/ván của bàn khác (của dự bị) lẫn vào Lọc bài.

## 5. Vì sao làm theo cách của tool đối thủ (2026-10-03)

| Cách | Kết quả | Bằng chứng |
|---|---|---|
| Lấy một **số bàn trong danh sách sảnh** rồi cùng vào **bằng op 3** | Không gom được nhóm | Log 09-21 11:28: B1 và B2 cùng gửi op 3 vào số bàn `3738108` → **mỗi acc thành chủ một bàn mới**. op 3 không phải lệnh "vào đúng bàn này". |
| **Tạo bàn riêng** (308) | Nhóm ngồi một mình | Phỏm bắt buộc có mật khẩu bàn (log 09-21 12:02), mà bàn có mật khẩu thì người chơi khác không vào được từ sảnh. |
| Một acc **xin bàn 313 rồi ngồi luôn** (bản 10-02) | Hay ngồi chung người lạ, KEY không phải chủ bàn | Câu trả lời 313 gọi tên bàn đang có người; ngồi vào đó thì chủ bàn là người lạ. |
| **Dò Key + Tạo + op 8** (tool đối thủ) | Đúng yêu cầu | Log 10-02 22:24–22:31: acc A ngồi một mình (chủ bàn), acc B dò 313 khoảng 85 giây rồi vào được bàn A bằng op 8, acc C bấm Vào cùng số bàn → 3 acc cùng bàn; acc CHƯA SS bị đá 10 giây/lần và vào lại 9 lần liên tiếp đúng bàn đó. |

Lỗi đã biết của tool đối thủ mà tool này **không** chép: nó vào thật mọi bàn có 1 người mà không kiểm tra người đó có
phải acc KEY không (log: acc C hai lần ngồi vào bàn của `riftraidpu454`). Tool này kiểm tra uid của KEY trong ps[] và
rời ngay nếu không phải.

Kéo theo đó, các phần sau đã gỡ vì không còn đường nào chạm tới: bộ lọc bàn (`table-qualify`), khoá tìm bàn
(`find-lock`), máy trạng thái HOST/FOLLOWER cũ (acquireHost / joinFollowers / runDiscovery / recoverHost), hai
thí nghiệm join (`join-experiment`, `host-anchored-join`), `room-scanner`, `shared-room-session`,
`stake-catalog`, `phom-simulator-controller`, ô chọn "người tìm bàn", bảng điều khiển thủ công cũ trong tool, lệnh
tạo bàn riêng 308 + bộ sinh key 6 số, và (2026-10-03) `findPublicTable` + giới hạn 5 lần vào lại/phút.

## 6. Trạng thái của mỗi acc (một nguồn duy nhất)

`desktop/protocol/phom/browser-state.cjs` tính **một** trạng thái cho mỗi trình duyệt; thanh trong trình duyệt và thẻ
P1/P2/P3 của tool hiện **cùng chữ**. Dự bị đi qua đúng các trạng thái này, chữ có thêm "DỰ BỊ P4 · …".

| Mã | Chữ hiện | Bước tiếp theo |
|---|---|---|
| CLOSED | CHƯA MỞ / ĐÃ TẮT | Mở trình duyệt; ô đã tắt → Đổi / Mở |
| DATA_STALE | MẤT DỮ LIỆU Ns · TẢI LẠI | Nút TẢI LẠI WEB |
| NOT_IN_GAME | CHƯA VÀO GAME | Đăng nhập — tool tự VÀO GAME (hoặc nút VÀO GAME) |
| ENTERING | ĐANG VÀO GAME | Chờ (tối đa có giới hạn, quá thì quay lại CHƯA VÀO GAME) |
| LOBBY | Ở SẢNH · bấm Dò Key / KEY đã ngồi · bấm Tạo / SS n · bấm Vào / NGOÀI BÀN · bấm ReJoin | Đúng nút ghi trong chữ |
| SEARCHING | ĐANG DÒ KEY / ĐANG DÒ BÀN KEY Ns · lần k | Chờ, hoặc bấm lại nút có dấu chấm để dừng |
| JOINING | ĐANG VÀO BÀN | Chờ |
| IN_TABLE | SS n (KÊNH n khi KEY chưa biết số bàn) | — |
| KICKED | BỊ ĐÁ · bấm ReJoin / BỊ ĐÁ · đang vào lại | ReJoin (tự vào lại nếu đã bật hoặc TỰ ĐỘNG) |
| LEAVE_UNCONFIRMED | CHƯA XÁC NHẬN RỜI BÀN — bấm Thoát lại | Thoát |
| ERROR | (chữ của sảnh) + lỗi hiện riêng | Lỗi tự xoá khi trạng thái đổi |

## 7. Kiểm thử thật (3 acc chơi + 2 dự bị) — chạy theo thứ tự, ghi lại số bàn và giờ

Chuẩn bị: 5 profile, mỗi profile một acc đã đăng nhập; tick đủ 5 → Mở trình duyệt; chọn Mức cược. Sau mỗi bước, đối
chiếu chữ trên thanh của từng trình duyệt với thẻ P1/P2/P3 (phải giống nhau). Log: `%APPDATA%/Phom QA/phom-captures/coseat.jsonl`.

| # | Làm | Phải thấy |
|---|---|---|
| K1 | Mở 5 trình duyệt | P1–P3 ở 3 ô; P4, P5 nằm sau tool. Cả 5 tự VÀO GAME; P4/P5 ghi "DỰ BỊ P4 · Ở SẢNH…". |
| K2 | (TAY) P1 Dò Key | P1 = KEY, "KÊNH …". Trong lúc đó bấm Vào ở P2 vẫn chạy được (tay độc lập). |
| K3 | P2 bấm Dò Key | Bị từ chối: "Đã có acc KEY (P1) đang ngồi…". |
| K4 | P2 Tạo, P3 Tạo cùng lúc | Acc tìm ra trước = SẴN SÀNG, acc còn lại dừng dò và Vào = CHƯA SS. SS giống nhau trên cả 5 thanh. |
| K5 | Bấm Vào lần nữa ở P2 khi P2 đang bận | "Acc này đang … — đợi xong hoặc bấm Dừng". |
| K6 | Không bấm ReJoin; chờ P3 (CHƯA SS) bị đá | Thanh P3: "BỊ ĐÁ · bấm ReJoin"; **không** tự vào lại. |
| K7 | Bấm ReJoin ở P3; chờ bị đá vài lần | Mỗi lần vào lại sau ~0,5 giây (log: KICKED → JOIN_SENT cách nhau < 1 giây). |
| K8 | Tích TỰ ĐỘNG | Thanh cả 5 trình duyệt hiện chip "TỰ ĐỘNG · …", nút bàn bị khoá; bấm vẫn bị từ chối. P4/P5 **không** bị cho ngồi. |
| K9 | Đổi P2 → P4 (dự bị đang ở sảnh) | P2 cũ rời bàn rồi lui ra sau tool; P4 vào ô P2, nhận vai SẴN SÀNG, ngồi vào bàn ngay; Lọc bài P2 = acc mới. |
| K10 | Đóng thẳng cửa sổ Chromium của P3 | P5 tự vào ô P3, nhận vai CHƯA SS (+ReJoin nếu có), vào bàn. Thông báo "đã tự thay bằng …". |
| K11 | Tắt P1 (KEY) bằng nút ⏻ trong tool | **Không** tự thay. Ô P1 hiện ô chọn → chọn dự bị (nếu còn) hoặc profile → Mở. KEY bị thay: nhóm giải tán (TỰ ĐỘNG: lập nhóm mới với acc mới làm KEY). |
| K12 | Ở acc khác bấm Dò Key khi nhóm còn thành viên (KEY không ngồi) | Lần 1: "Đang có nhóm… bấm lần nữa trong 5 giây"; lần 2 trong 5 giây: nhóm mới. |
| K13 | Bật / tắt Ẩn danh | Tắt: số bàn trên 3 trình duyệt giống nhau và bằng SS, không có người chơi giả. Log AN_DANH_SET: managers 1. |
| K14 | Lỗi bàn đầy (nếu gặp lại) | Gửi file coseat.jsonl: JOIN_ACK có serverFrame + money, TABLE_DIAG có maxPlayers — đủ để tìm nguyên nhân. |
