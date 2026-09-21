# Phân tích capture thao tác ngày 2026-09-21

Nguồn: JSON đi kèm file TXT do người dùng cung cấp, `test-D-2026-09-21T04-30-13-016Z.json`. Đã duyệt toàn bộ 311 frame; thời lượng 53.669 ms, dropped=0 theo recorder. Không suy ra rằng recorder đã bắt mọi socket ngoài phạm vi hook. Không ghi token, tài khoản hoặc password vào báo cáo.

## Phát hiện chính

- 23 request CMD300 chỉ có cmd/aid/gid (gid=8); 26 response CMD300. Không có tokenKey hay scanId/attemptId trong envelope. Chênh lệch số request/response không cho phép ghép một-một chỉ theo thứ tự.
- Cả ba browser gửi JOIN `[3, zone, 3588738, roomCode]`. RoomCode đã che trong capture nên không thể so sánh giá trị giữa browser hoặc xác định mã được lấy từ đâu.
- JOIN ACK thành công là `[3,true,0,-1,null]`: không trả RID thực tế. Sáu TABLE_STATE CMD202 cũng không có RID.
- t=25.674s: B2 nhận bàn một người U1. t=25.778s: B1 nhận U2/U3; lặp lại tại 27.499s và 29.111s. t=29.812s: B3 nhận U1/U4. Các nhãn U được gán theo UID trong cùng capture; không phải định danh thật. B1 không có bằng chứng cùng bàn với B2/B3 dù request có cùng RID.
- Sáu request READY CMD363 đều aRd="true", xuất hiện khoảng 2–3 ms sau TABLE_STATE (trừ lần đầu khoảng 3 ms). Capture không có provenance để phân biệt game client, automation hay thao tác người dùng; không kết luận nguồn gửi chỉ dựa trên timing. Không có UNREADY.
- B1 lặp JOIN → TABLE_STATE không chứa anchor → LEAVE → CMD300. ACK LEAVE có mặt. Đây là dấu hiệu kiểm tra membership đang phát hiện mismatch, không phải bằng chứng RID request định danh duy nhất một bàn.
- t=34.104s, 34.762s, 35.414s: server từ chối JOIN với code102, RID3588738, “Phòng không tồn tại”. Code trước sửa vẫn retry cùng RID.
- TABLE_STATE trong capture có b=100, Mu=4, gS=1. Đây là mức tiền quan sát, chưa chứng minh betId hay ý nghĩa state enum ngoài parser hiện có.
- Sau khoảng 47.8s có login/identity và traffic game khác. Đã kiểm kê, không dùng làm bằng chứng mapping Phỏm.

## Thay đổi dựa trên capture

- Cả JOIN_SHARED và JOIN_BY_CODE dừng retry cùng RID khi serverCode=102 kèm thông báo phòng không tồn tại; regex thông báo phòng không còn ghi đè quyết định này.
- Khi cleanup do ROOM_MISMATCH không nhận xác nhận LEAVE, giữ LEAVE_UNCONFIRMED và trả lỗi; không báo “đã rời bàn” hoặc ghi đè thành FOLLOWER_ERROR.
- Thêm regression test hai đường JOIN cho code102 kèm lý do phòng không tồn tại; vẫn giữ retry đổi key khi server báo sai mật khẩu. Chưa bật scanner token hoặc điền catalog bằng ID phỏng đoán.

## Kiểm kê toàn bộ frame theo hướng / op / cmd

| Hướng | op | cmd | Số frame |
|---|---|---|---|
| send | 6 | 300 | 23 |
| recv | 5 | 300 | 26 |
| send | 7 | — | 52 |
| recv | 6 | — | 52 |
| send | 3 | — | 10 |
| recv | 3 | — | 9 |
| recv | 5 | 202 | 6 |
| send | 6 | 363 | 6 |
| recv | 5 | 317 | 11 |
| send | 5 | 5 | 9 |
| send | 4 | — | 4 |
| recv | 5 | 5 | 10 |
| recv | 4 | — | 5 |
| recv | 5 | 200 | 2 |
| recv | 2 | — | 2 |
| send | 6 | 10002 | 1 |
| send | 2 | — | 1 |
| recv | 5 | 203 | 1 |
| send | 1 | — | 2 |
| recv | 1 | — | 2 |
| send | 6 | 20 | 1 |
| recv | 5 | 100 | 2 |
| recv | 5 | 104 | 1 |
| recv | 5 | 20 | 1 |
| send | 6 | 10001 | 1 |
| recv | 5 | 10004 | 11 |
| recv | 5 | 1016 | 1 |
| recv | 5 | 2011 | 1 |
| recv | 5 | 10001 | 1 |
| recv | 5 | 10003 | 3 |
| recv | 5 | 1015 | 2 |

## Metadata danh sách phòng được quan sát

Các giá trị dưới đây là rn / rid / b từ response, không phải catalog betId.

| rn | rid | b |
|---|---|---|
| Phom | 2754636 | 1000 |
| Phom | 3116603 | 2000 |
| Phom | 3126783 | 2000 |
| Phom | 3127426 | 2000 |
| Phom | 3127980 | 2000 |
| Phom | 3128286 | 2000 |
| Phom | 3145231 | 2000 |
| Phom | 3145617 | 2000 |
| Phom | 3147692 | 2000 |
| Phom | 3148473 | 2000 |
| Phom | 3158288 | 5000 |
| Phom | 3229563 | 500 |
| Phom | 3238131 | 500 |
| Phom | 3240817 | 2000 |
| Phom | 3317962 | 500 |
| Phom | 3365493 | 2000 |
| Phom | 3366956 | 2000 |
| Phom | 3417883 | 500 |
| Phom | 3420377 | 1000 |
| Phom | 3421171 | 1000 |
| Phom | 3422395 | 2000 |
| Phom | 3422541 | 1000 |
| Phom | 3427438 | 5000 |
| Phom | 3431074 | 1000 |
| Phom | 3431116 | 1000 |
| Phom | 3432466 | 10000 |
| Phom | 3434176 | 5000 |
| Phom | 3434637 | 5000 |
| Phom | 3434842 | 5000 |
| Phom | 3436087 | 5000 |
| Phom | 3436840 | 10000 |
| Phom | 3437363 | 10000 |
| Phom | 3438016 | 10000 |
| Phom | 3470892 | 500 |
| Phom | 3490948 | 500 |
| Phom | 3493044 | 5000 |
| Phom | 3493107 | 5000 |
| Phom | 3493109 | 5000 |
| Phom | 3493154 | 5000 |
| Phom | 3493270 | 5000 |
| Phom | 3496218 | 5000 |
| Phom | 3496258 | 5000 |
| Phom | 3496334 | 5000 |
| Phom | 3496355 | 5000 |
| Phom | 3497196 | 50000 |
| Phom | 3497322 | 5000 |
| Phom | 3497976 | 50000 |
| Phom | 3499111 | 50000 |
| Phom | 3499444 | 50000 |
| Phom | 3499771 | 5000 |
| Phom | 3499821 | 5000 |
| Phom | 3499837 | 5000 |
| Phom | 3499914 | 5000 |
| Phom | 3499980 | 5000 |
| Phom | 3500815 | 50000 |
| Phom | 3500971 | 50000 |
| Phom | 3501894 | 50000 |
| Phom | 3502354 | 100000 |
| Phom | 3502593 | 100000 |
| Phom | 3502824 | 100000 |
| Phom | 3503035 | 500 |
| Phom | 3503178 | 500 |
| Phom | 3504154 | 100000 |
| Phom | 3506129 | 1000 |
| Phom | 3506535 | 1000 |
| Phom | 3507862 | 2000 |
| Phom | 3510595 | 100000 |
| Phom | 3512244 | 5000 |
| Phom | 3512252 | 5000 |
| Phom | 3512288 | 5000 |
| Phom | 3512700 | 5000 |
| Phom | 3512727 | 5000 |
| Phom | 3514078 | 20000 |
| Phom | 3514461 | 5000 |
| Phom | 3515706 | 2000 |
| Phom | 3516628 | 2000 |
| Phom | 3519366 | 5000 |
| Phom | 3520516 | 5000 |
| Phom | 3521244 | 5000 |
| Phom | 3521255 | 5000 |
| Phom | 3521519 | 5000 |
| Phom | 3521804 | 5000 |
| Phom | 3521978 | 5000 |
| Phom | 3522701 | 5000 |
| Phom | 3523684 | 5000 |
| Phom | 3524520 | 5000 |
| Phom | 3528124 | 50000 |
| Phom | 3528808 | 50000 |
| Phom | 3529159 | 50000 |
| Phom | 3534575 | 5000 |
| Phom | 3534945 | 2000 |
| Phom | 3535039 | 5000 |
| Phom | 3535273 | 5000 |
| Phom | 3536286 | 2000 |
| Phom | 3536334 | 10000 |
| Phom | 3537704 | 10000 |
| Phom | 3538120 | 10000 |
| Phom | 3538469 | 2000 |
| Phom | 3538510 | 10000 |
| Phom | 3538594 | 10000 |
| Phom | 3538670 | 10000 |
| Phom | 3538973 | 5000 |
| Phom | 3539276 | 10000 |
| Phom | 3539539 | 5000 |
| Phom | 3539816 | 2000 |
| Phom | 3540464 | 5000 |
| Phom | 3540536 | 5000 |
| Phom | 3540689 | 5000 |
| Phom | 3541389 | 5000 |
| Phom | 3542002 | 2000 |
| Phom | 3543818 | 2000 |
| Phom | 3544394 | 10000 |
| Phom | 3544498 | 50000 |
| Phom | 3545009 | 1000 |
| Phom | 3545103 | 50000 |
| Phom | 3545226 | 10000 |
| Phom | 3545573 | 2000 |
| Phom | 3545694 | 1000 |
| Phom | 3546338 | 100000 |
| Phom | 3546385 | 5000 |
| Phom | 3546716 | 500 |
| Phom | 3546760 | 100000 |
| Phom | 3547105 | 100000 |
| Phom | 3548627 | 20000 |
| Phom | 3548752 | 50000 |
| Phom | 3548844 | 5000 |
| Phom | 3549714 | 10000 |
| Phom | 3550015 | 500 |
| Phom | 3550332 | 1000 |
| Phom | 3550468 | 1000 |
| Phom | 3550726 | 5000 |
| Phom | 3550745 | 5000 |
| Phom | 3550954 | 2000 |
| Phom | 3551057 | 5000 |
| Phom | 3551061 | 1000 |
| Phom | 3551271 | 5000 |
| Phom | 3551750 | 2000 |
| Phom | 3552591 | 2000 |
| Phom | 3553146 | 1000 |
| Phom | 3553201 | 10000 |
| Phom | 3553210 | 1000 |
| Phom | 3553257 | 1000 |
| Phom | 3553326 | 2000 |
| Phom | 3553531 | 2000 |
| Phom | 3553700 | 2000 |
| Phom | 3553929 | 2000 |
| Phom | 3554223 | 2000 |
| Phom | 3554259 | 2000 |
| Phom | 3554568 | 1000 |
| Phom | 3554836 | 2000 |
| Phom | 3556429 | 5000 |
| Phom | 3556955 | 100 |
| Phom | 3559332 | 10000 |
| Phom | 3559538 | 20000 |
| Phom | 3559719 | 2000 |
| Phom | 3559769 | 2000 |
| Phom | 3559844 | 2000 |
| Phom | 3559871 | 2000 |
| Phom | 3559939 | 1000 |
| Phom | 3561015 | 10000 |
| Phom | 3561273 | 2000 |
| Phom | 3562745 | 2000 |
| Phom | 3563498 | 2000 |
| Phom | 3564795 | 20000 |
| Phom | 3564810 | 20000 |
| Phom | 3565636 | 5000 |
| Phom | 3565926 | 10000 |
| Phom | 3566597 | 100 |
| Phom | 3566836 | 20000 |
| Phom | 3569353 | 10000 |
| Phom | 3569406 | 2000 |
| Phom | 3569610 | 20000 |
| Phom | 3570101 | 10000 |
| Phom | 3570163 | 20000 |
| Phom | 3570272 | 20000 |
| Phom | 3571434 | 1000 |
| Phom | 3571584 | 1000 |
| Phom | 3571814 | 1000 |
| Phom | 3571840 | 1000 |
| Phom | 3572319 | 5000 |
| Phom | 3572401 | 1000 |
| Phom | 3572432 | 10000 |
| Phom | 3572499 | 2000 |
| Phom | 3572868 | 20000 |
| Phom | 3573040 | 20000 |
| Phom | 3573910 | 10000 |
| Phom | 3574470 | 20000 |
| Phom | 3574876 | 20000 |
| Phom | 3574987 | 2000 |
| Phom | 3575084 | 500 |
| Phom | 3575161 | 500 |
| Phom | 3575598 | 20000 |
| Phom | 3575657 | 20000 |
| Phom | 3576678 | 2000 |
| Phom | 3577282 | 1000 |
| Phom | 3577591 | 5000 |
| Phom | 3577959 | 5000 |
| Phom | 3578098 | 50000 |
| Phom | 3578185 | 5000 |
| Phom | 3578442 | 10000 |
| Phom | 3578462 | 10000 |
| Phom | 3578665 | 20000 |
| Phom | 3579930 | 20000 |
| Phom | 3579963 | 10000 |
| Phom | 3580237 | 1000 |
| Phom | 3581709 | 10000 |
| Phom | 3582385 | 10000 |
| Phom | 3582463 | 20000 |
| Phom | 3582488 | 10000 |
| Phom | 3582510 | 20000 |
| Phom | 3582924 | 10000 |
| Phom | 3583041 | 10000 |
| Phom | 3583051 | 5000 |
| Phom | 3583159 | 20000 |
| Phom | 3583610 | 10000 |
| Phom | 3583703 | 10000 |
| Phom | 3583800 | 20000 |
| Phom | 3583999 | 20000 |
| Phom | 3584516 | 10000 |
| Phom | 3584573 | 10000 |
| Phom | 3584661 | 20000 |
| Phom | 3584721 | 2000 |
| Phom | 3584729 | 20000 |
| Phom | 3584804 | 5000 |
| Phom | 3585322 | 20000 |
| Phom | 3585518 | 2000 |
| Phom | 3585616 | 5000 |
| Phom | 3585717 | 10000 |
| Phom | 3586178 | 5000 |
| Phom | 3586409 | 5000 |
| Phom | 3586485 | 10000 |
| Phom | 3586551 | 10000 |
| Phom | 3586717 | 20000 |
| Phom | 3586863 | 20000 |
| Phom | 3586873 | 20000 |
| Phom | 3586949 | 10000 |
| Phom | 3586986 | 50000 |
| Phom | 3586995 | 20000 |
| Phom | 3587051 | 20000 |
| Phom | 3587433 | 10000 |
| Phom | 3587436 | 5000 |
| Phom | 3587642 | 10000 |
| Phom | 3587676 | 2000 |
| Phom | 3587915 | 10000 |
| Phom | 3587964 | 10000 |
| Phom | 3588016 | 2000 |
| Phom | 3588172 | 20000 |
| Phom | 3588198 | 10000 |
| Phom | 3588201 | 100 |
| Phom | 3588216 | 10000 |
| Phom | 3588259 | 20000 |
| Phom | 3588344 | 5000 |
| Phom | 3588393 | 5000 |
| Phom | 3588410 | 20000 |
| Phom | 3588418 | 5000 |
| Phom | 3588453 | 20000 |
| Phom | 3588528 | 10000 |
| Phom | 3588563 | 10000 |
| Phom | 3588587 | 10000 |
| Phom | 3588622 | 5000 |
| Phom | 3588633 | 20000 |
| Phom | 3588653 | 2000 |
| Phom | 3588725 | 20000 |
| Phom | 3588726 | 10000 |
| Phom | 3588738 | 100 |
| Phom#0 | 139 | 100 |
| Phom#1 | 140 | 500 |
| Phom#10 | 149 | 500000 |
| Phom#11 | 150 | 1000000 |
| Phom#12 | 151 | 2000000 |
| Phom#13 | 152 | 5000000 |
| Phom#2 | 141 | 1000 |
| Phom#3 | 142 | 2000 |
| Phom#4 | 143 | 5000 |
| Phom#5 | 144 | 10000 |
| Phom#6 | 145 | 20000 |
| Phom#7 | 146 | 50000 |
| Phom#8 | 147 | 100000 |
| Phom#9 | 148 | 200000 |

## Phần còn thiếu

Request thật sử dụng tokenKey; bằng chứng mapping nhãn cược ↔ betId; cơ chế xác nhận RID và correlation; packet UNREADY. Capture hiện tại chưa đủ để triển khai các phần này đúng protocol.
