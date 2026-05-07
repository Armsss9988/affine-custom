# Hướng dẫn sử dụng AFFiNE

## AFFiNE là gì?

AFFiNE là một ứng dụng workspace tích hợp, mã nguồn mở, thay thế cho Notion, Miro và Monday. AFFiNE kết hợp 3 công cụ chính:
- **Docs** (Page Mode): Soạn thảo tài liệu với block editor
- **Whiteboard** (Edgeless Mode): Bảng trắng vô hạn để brainstorm
- **Database**: Quản lý dữ liệu dạng Kanban, Table, List

AFFiNE hoạt động theo nguyên tắc **Local-first** — dữ liệu lưu trên máy trước, đồng bộ cloud sau.

## Bắt đầu sử dụng

### Tạo Workspace
1. Mở AFFiNE → click vào tên workspace ở sidebar trái
2. Click **"New Workspace"**
3. Đặt tên workspace
4. Chọn loại: Local (lưu máy) hoặc Cloud (đồng bộ)

### Tạo Page mới
1. Click nút **"+"** ở sidebar hoặc nhấn phím tắt
2. Bắt đầu gõ tiêu đề
3. Nhấn Enter để xuống dòng và bắt đầu viết nội dung
4. Dùng lệnh **"/"** (slash command) để chèn các loại block

## Page Mode (Soạn thảo tài liệu)

### Slash Commands
Gõ **"/"** để mở menu chèn block:
- `/heading` hoặc `/h1`, `/h2`, `/h3`: Tiêu đề
- `/todo`: Checkbox todo
- `/list` hoặc `/bullet`: Danh sách
- `/numbered`: Danh sách đánh số
- `/code`: Block code
- `/quote`: Trích dẫn
- `/divider`: Đường kẻ ngang
- `/image`: Chèn ảnh
- `/file`: Đính kèm file
- `/table`: Bảng
- `/database`: Database view
- `/link`: Link đến page khác

### Định dạng văn bản
- **Bold**: Ctrl+B hoặc gõ `**text**`
- *Italic*: Ctrl+I hoặc gõ `*text*`
- ~~Strikethrough~~: Gõ `~~text~~`
- `Code inline`: Ctrl+E hoặc gõ `` `code` ``
- Highlight: Chọn text → thanh công cụ → chọn màu highlight

### Di chuyển Block
- Hover vào block → kéo thả bằng handle (⠿) bên trái
- Hoặc dùng phím tắt để di chuyển block lên/xuống

## Edgeless Mode (Whiteboard)

### Chuyển sang Whiteboard
- Click nút chuyển mode ở góc trên phải trang
- Hoặc tạo page mới → chọn Edgeless mode

### Công cụ trên Whiteboard
- **Bút vẽ (Pen)**: Vẽ tự do trên canvas
- **Shape**: Thêm hình (vuông, tròn, tam giác, etc.)
- **Text**: Thêm text box
- **Sticky Note**: Thêm ghi chú dính
- **Connector**: Nối các phần tử với nhau
- **Frame**: Nhóm các phần tử lại
- **Image**: Chèn ảnh lên canvas

### Thao tác trên Canvas
- **Zoom**: Cuộn chuột hoặc Ctrl + cuộn
- **Pan (di chuyển)**: Giữ Space + kéo chuột
- **Select**: Click chọn phần tử, Shift+click chọn nhiều
- **Group**: Chọn nhiều → chuột phải → Group

### Nhúng Page vào Whiteboard
- Kéo page từ sidebar vào canvas
- Page sẽ hiển thị dưới dạng card có thể mở rộng

## Database Views

### Tạo Database
1. Gõ `/database` trong page
2. Chọn loại view: Table, Kanban, hoặc List

### Table View (Bảng)
- Thêm cột: Click "+" ở header
- Loại cột: Text, Number, Date, Select, Multi-select, Checkbox, Link
- Sắp xếp: Click header cột → Sort
- Lọc: Click icon Filter → thiết lập điều kiện

### Kanban View
- Tổ chức card theo cột trạng thái
- Kéo thả card giữa các cột
- Thêm card mới: Click "+" ở cuối cột
- Thay đổi nhóm: Chọn property để group by

### List View
- Hiển thị dữ liệu dạng danh sách đơn giản
- Nhẹ nhàng, phù hợp cho task list

### Chuyển đổi View
- Click tên view ở trên database
- Click "+" để thêm view mới cho cùng dữ liệu
- Cùng 1 database có thể có nhiều views khác nhau

## Quản lý Workspace

### Sidebar
- **All Pages**: Xem tất cả trang
- **Favorites**: Trang đã đánh dấu yêu thích
- **Collections**: Nhóm trang theo bộ sưu tập
- **Trash**: Thùng rác (khôi phục trang đã xóa)
- **Tags**: Gắn tag và lọc theo tag

### Tìm kiếm
- Nhấn **Ctrl+K** (hoặc Cmd+K trên Mac) để mở Quick Search
- Gõ từ khóa để tìm trang, block, hoặc nội dung
- Kết quả hiển thị realtime khi gõ

### Import / Export
- **Import**: Settings → Import → hỗ trợ Markdown, HTML, Notion export
- **Export**: Click "..." trên page → Export → chọn Markdown, HTML, hoặc PDF

## Phím tắt quan trọng

| Phím tắt | Chức năng |
|----------|-----------|
| Ctrl+N | Tạo page mới |
| Ctrl+K | Quick Search |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+B | Bold |
| Ctrl+I | Italic |
| Ctrl+E | Code inline |
| Ctrl+Shift+H | Highlight |
| Ctrl+D | Duplicate block |
| Ctrl+/ | Mở slash command |
| Tab | Indent block |
| Shift+Tab | Outdent block |
| Ctrl+Enter | Toggle todo checkbox |

## Collaboration (Cộng tác)

### Chia sẻ Workspace
1. Click tên workspace → Settings
2. Vào tab "Members"
3. Mời thành viên qua email
4. Đặt quyền: Admin, Editor, hoặc Viewer

### Real-time Sync
- Nhiều người chỉnh sửa cùng lúc
- Thấy cursor và thay đổi của người khác realtime
- Lịch sử phiên bản tự động lưu

## AI Copilot

### Sử dụng AI
1. Chọn text → menu AI xuất hiện
2. Hoặc mở sidebar chat (icon AI bên phải)

### Các tính năng AI
- **Viết nội dung**: Nhờ AI viết draft, mở rộng ý tưởng
- **Chỉnh sửa**: Fix lỗi chính tả, grammar, điều chỉnh tone
- **Tóm tắt**: Rút gọn nội dung dài thành key points
- **Dịch thuật**: Dịch text sang ngôn ngữ khác
- **Mind Map**: Biến notes thành mind map
- **Tạo Slides**: One-click tạo presentation từ notes
- **Giải thích ảnh**: Upload ảnh → AI mô tả nội dung

### Chat với AI
- Mở AI sidebar → gõ câu hỏi
- AI có thể đọc nội dung trang đang mở
- Hỏi đáp, so sánh, tổng hợp thông tin

## Mẹo sử dụng

### Tổ chức hiệu quả
- Dùng **Collections** để nhóm trang theo dự án
- Gắn **Tags** để phân loại nội dung
- Dùng **Favorites** cho trang truy cập thường xuyên
- Tạo **Table of Contents** cho trang dài

### Tối ưu workflow
- Kết hợp Page Mode và Edgeless Mode cho cùng 1 trang
- Dùng Database Kanban để quản lý task
- Link giữa các trang bằng `[[tên trang]]`
- Dùng Templates cho các loại trang lặp lại

### Bảo mật
- Dữ liệu local-first: lưu trên máy trước
- Mã hóa end-to-end cho cloud sync
- Self-host: toàn quyền kiểm soát dữ liệu
- Backup định kỳ workspace
