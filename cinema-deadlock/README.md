# 🎬 Cinema Deadlock Demo — DBMS Course

## Mô tả

Demo trực quan về **Deadlock trong DBMS** thông qua bài toán đặt vé ghế rạp chiếu phim.

## Tính năng

- **2 Transaction Panel song song** (T1 và T2) — giả lập 2 client độc lập
- **Real-time SQL logging** qua WebSocket — thấy từng câu lệnh SQL
- **Auto Deadlock Demo** — tự động tạo deadlock T1↔T2
- **Wait-for Graph Visualizer** — xem trực quan vòng tròn chờ đợi
- **Fix Deadlock** — Ordered Locking, 2PL, Lock Timeout
- **PostgreSQL Monitor** — xem active locks real-time
- **Booking Management** — lịch sử đặt vé

## Chạy với Docker

```bash
# Clone/unzip project
cd cinema-deadlock

# Build và chạy
docker compose up --build

# Truy cập
# Frontend: http://localhost:3000
# Backend API: http://localhost:3001
```

## Hướng dẫn Demo Deadlock

### Cách 1: Auto Demo (Khuyên dùng)
1. Nhấn **⚡ AUTO DEADLOCK DEMO**
2. Xem T1 và T2 chạy song song
3. Quan sát SQL Console — thấy DEADLOCK!

### Cách 2: Manual (Cho demo chi tiết)

**Bước 1:** T1 nhấn `BEGIN`, T2 nhấn `BEGIN`

**Bước 2:** T1 chọn ghế A4 → `SELECT FOR UPDATE` ✅

**Bước 3:** T2 chọn ghế A5 → `SELECT FOR UPDATE` ✅

**Bước 4:** T1 chọn ghế A5 → `SELECT FOR UPDATE` ⏳ (chờ T2)

**Bước 5:** T2 chọn ghế A4 → `SELECT FOR UPDATE` 💀 DEADLOCK!

PostgreSQL tự động phát hiện chu trình và rollback một giao dịch (victim).

### Fix Deadlock
Tab **"🔧 Fix Deadlock"** → chọn 2 ghế → **Ordered Locking**

SQL được sort theo ID tăng dần → không bao giờ có vòng tròn chờ.

## SQL Quan trọng

```sql
-- Gây deadlock
SELECT * FROM seats WHERE id = ? FOR UPDATE;

-- Phát hiện deadlock
SELECT * FROM detect_deadlock_graph();

-- Fix: Ordered locking
SELECT * FROM seats WHERE id IN (3,7) ORDER BY id FOR UPDATE;

-- Timeout config
SET lock_timeout = '5s';
SET deadlock_timeout = '2s';
```

## Kiến trúc

```
nginx:3000 (Frontend)
    ↓ /api/*
backend:3001 (Node.js + Express)
    ↓
postgres:5432 (PostgreSQL 15)
```

Mỗi Transaction Panel dùng 1 **dedicated DB connection** riêng — đây là điều kiện cần thiết để tạo deadlock thật sự trong PostgreSQL.
