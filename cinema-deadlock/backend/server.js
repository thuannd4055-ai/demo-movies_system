/**
 * CINEMA DEADLOCK DEMO - Backend Server
 * DBMS Course - Deadlock Detection & Recovery Demo
 * 
 * Architecture:
 * - REST API for seat management, booking
 * - WebSocket for real-time SQL log streaming
 * - Dedicated DB connections per "transaction session" to simulate deadlock
 */

const express = require('express');
const { Pool, Client } = require('pg');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// ============================================================
// WebSocket Server - Real-time SQL log streaming
// ============================================================
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

// ============================================================
// Database Configuration
// ============================================================
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'cinema_db',
    user: process.env.DB_USER || 'cinema_user',
    password: process.env.DB_PASSWORD || 'cinema_pass',
};

// Main pool for regular queries
const pool = new Pool({ ...dbConfig, max: 20 });

// Store for active transaction clients (for deadlock simulation)
// Key: sessionId -> { client, steps: [] }
const activeSessions = new Map();

pool.on('error', (err) => {
    console.error('Pool error:', err.message);
});

// ============================================================
// Middleware
// ============================================================
app.use(cors({ origin: '*' }));
app.use(express.json());

// SQL Logger middleware
function sqlLog(sessionId, txId, step, sql, result, status, durationMs = 0) {
    const logEntry = {
        type: 'sql_log',
        sessionId,
        transactionId: txId,
        step,
        sql: sql.trim(),
        result: typeof result === 'object' ? JSON.stringify(result) : String(result || ''),
        status, // success | error | waiting | deadlock | info
        timestamp: new Date().toISOString(),
        durationMs
    };

    broadcast(logEntry);

    // Persist to DB (non-blocking)
    pool.query(
        `INSERT INTO transaction_log (session_id, transaction_id, step_number, sql_command, result, status, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, txId, step, sql.trim(), logEntry.result, status, durationMs]
    ).catch(() => {});

    return logEntry;
}

// ============================================================
// ROUTES: General Data
// ============================================================

// Health check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', message: 'Cinema Deadlock Demo is running!' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Get showtimes with movies
app.get('/api/showtimes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                st.id,
                m.title,
                m.genre,
                m.duration,
                st.show_date::text,
                st.show_time::text,
                st.hall,
                COUNT(CASE WHEN s.status = 'available' THEN 1 END) AS available_seats,
                COUNT(s.id) AS total_seats
            FROM showtimes st
            JOIN movies m ON st.movie_id = m.id
            LEFT JOIN seats s ON s.showtime_id = st.id
            GROUP BY st.id, m.title, m.genre, m.duration, st.show_date, st.show_time, st.hall
            ORDER BY st.show_date, st.show_time
        `);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get seats for a showtime
app.get('/api/seats/:showtimeId', async (req, res) => {
    try {
        const { showtimeId } = req.params;
        const result = await pool.query(`
            SELECT 
                s.id,
                s.seat_row,
                s.seat_number,
                s.seat_row || s.seat_number AS seat_label,
                s.seat_type,
                s.status,
                s.locked_by,
                s.price,
                TO_CHAR(s.locked_at, 'HH24:MI:SS') AS locked_at
            FROM seats s
            WHERE s.showtime_id = $1
            ORDER BY s.seat_row, s.seat_number
        `, [showtimeId]);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get bookings
app.get('/api/bookings', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                b.*,
                s.seat_row || s.seat_number AS seat_label,
                m.title AS movie_title,
                st.show_time::text,
                st.hall
            FROM bookings b
            JOIN seats s ON b.seat_id = s.id
            JOIN showtimes st ON b.showtime_id = st.id
            JOIN movies m ON st.movie_id = m.id
            ORDER BY b.booked_at DESC
            LIMIT 50
        `);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get transaction logs
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM transaction_log
            WHERE executed_at > NOW() - INTERVAL '2 hours'
            ORDER BY executed_at DESC
            LIMIT 200
        `);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get deadlock logs
app.get('/api/deadlock-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM deadlock_log ORDER BY detected_at DESC LIMIT 50
        `);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get active locks from PostgreSQL system view
app.get('/api/locks', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                pid,
                usename,
                state,
                wait_event_type,
                wait_event,
                EXTRACT(EPOCH FROM (NOW() - query_start))::INTEGER AS wait_seconds,
                LEFT(query, 150) AS query_preview,
                backend_xid::text
            FROM pg_stat_activity
            WHERE state != 'idle'
              AND pid != pg_backend_pid()
            ORDER BY query_start
        `);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Detect wait-for graph
app.get('/api/detect-deadlock', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM detect_deadlock_graph()`);
        res.json({ success: true, data: result.rows, hasDeadlock: result.rows.length > 0 });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Reset demo
app.post('/api/reset', async (req, res) => {
    try {
        // Kill any active demo sessions
        for (const [sid, sess] of activeSessions.entries()) {
            try {
                await sess.client.query('ROLLBACK');
                sess.client.release();
            } catch(e) {}
            activeSessions.delete(sid);
        }

        const result = await pool.query('SELECT reset_demo()');
        broadcast({ type: 'reset', message: 'Demo đã được reset!' });
        res.json({ success: true, message: result.rows[0].reset_demo });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// DEADLOCK SIMULATION ROUTES
// The key mechanism:
// Session A: BEGIN -> SELECT FOR UPDATE seat1 -> wait -> SELECT FOR UPDATE seat2
// Session B: BEGIN -> SELECT FOR UPDATE seat2 -> wait -> SELECT FOR UPDATE seat1
// => DEADLOCK! PostgreSQL will detect and kill one transaction
// ============================================================

/**
 * Step 1: Start transaction session
 * Creates a dedicated DB client that persists across requests
 */
app.post('/api/tx/begin', async (req, res) => {
    const { sessionId, customerName } = req.body;

    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'sessionId required' });
    }

    // Release existing session if any
    if (activeSessions.has(sessionId)) {
        const old = activeSessions.get(sessionId);
        try { 
            await old.client.query('ROLLBACK');
            old.client.release(); 
        } catch(e) {}
        activeSessions.delete(sessionId);
    }

    try {
        const client = await pool.connect();
        activeSessions.set(sessionId, { 
            client, 
            customerName: customerName || 'Customer',
            step: 0,
            lockedSeats: []
        });

        const t0 = Date.now();
        
        // SET lock_timeout - important for deadlock detection
        await client.query(`SET lock_timeout = '10s'`);
        await client.query(`SET deadlock_timeout = '2s'`);
        await client.query('BEGIN');
        
        const dur = Date.now() - t0;

        const sql1 = `SET lock_timeout = '10s';\nSET deadlock_timeout = '2s';`;
        const sql2 = `BEGIN; -- Bắt đầu giao dịch [${sessionId}]`;

        sqlLog(sessionId, sessionId, 1, sql1, 'OK - Cấu hình timeout', 'info', dur);
        sqlLog(sessionId, sessionId, 2, sql2, 'Transaction started', 'success', dur);

        broadcast({ 
            type: 'tx_started', 
            sessionId, 
            message: `✅ Giao dịch ${sessionId} bắt đầu` 
        });

        res.json({ 
            success: true, 
            sessionId,
            message: `Giao dịch ${sessionId} đã bắt đầu (BEGIN)` 
        });

    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * Step 2: Lock a seat with SELECT FOR UPDATE
 * This is where the magic (and deadlock) happens
 */
app.post('/api/tx/lock-seat', async (req, res) => {
    const { sessionId, seatId, delay = 0 } = req.body;

    const session = activeSessions.get(sessionId);
    if (!session) {
        return res.status(400).json({ success: false, message: 'Session not found. Call BEGIN first.' });
    }

    session.step++;
    const stepNum = session.step;

    // Optional delay to make deadlock more visible
    if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
    }

    const sql = `-- [${sessionId}] Bước ${stepNum}: Khóa ghế ${seatId}
SELECT id, seat_row, seat_number, seat_type, status, price
FROM seats
WHERE id = ${seatId}
FOR UPDATE;  -- Đặt WRITE LOCK (khóa độc quyền)`;

    const t0 = Date.now();

    try {
        sqlLog(sessionId, sessionId, stepNum, 
            `SELECT * FROM seats WHERE id = ${seatId} FOR UPDATE; -- [${sessionId}] đang cố khóa ghế #${seatId}`,
            'Đang chờ khóa...', 'waiting', 0);

        broadcast({ 
            type: 'locking', 
            sessionId, 
            seatId,
            message: `🔒 [${sessionId}] đang yêu cầu khóa ghế #${seatId}...` 
        });

        // This SELECT FOR UPDATE will BLOCK if another session holds the lock
        // This is what creates the deadlock condition
        const result = await session.client.query(`
            SELECT 
                s.id, 
                s.seat_row, 
                s.seat_number,
                s.seat_row || s.seat_number::text AS seat_label,
                s.seat_type, 
                s.status, 
                s.price,
                s.locked_by
            FROM seats s
            WHERE s.id = $1
            FOR UPDATE
        `, [seatId]);

        const dur = Date.now() - t0;

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Seat not found' });
        }

        const seat = result.rows[0];
        session.lockedSeats.push(seatId);

        sqlLog(sessionId, sessionId, stepNum, 
            `SELECT * FROM seats WHERE id = ${seatId} FOR UPDATE;`,
            `✅ Đã khóa ghế ${seat.seat_label} (${seat.seat_type}) - ${seat.price}đ`,
            'success', dur);

        broadcast({ 
            type: 'seat_locked', 
            sessionId, 
            seatId,
            seatLabel: seat.seat_label,
            message: `🔒 [${sessionId}] đã khóa ghế ${seat.seat_label}` 
        });

        res.json({ 
            success: true, 
            seat,
            durationMs: dur,
            message: `Đã khóa ghế ${seat.seat_label} thành công` 
        });

    } catch (e) {
        const dur = Date.now() - t0;
        const isDeadlock = e.code === '40P01';
        const isTimeout = e.code === '55P03' || e.code === '40001';

        const status = isDeadlock ? 'deadlock' : 'error';
        const errorMsg = isDeadlock 
            ? `💀 DEADLOCK DETECTED! PostgreSQL đã rollback giao dịch ${sessionId}` 
            : `❌ Lỗi: ${e.message}`;

        sqlLog(sessionId, sessionId, stepNum,
            `SELECT * FROM seats WHERE id = ${seatId} FOR UPDATE;`,
            errorMsg, status, dur);

        if (isDeadlock) {
            // Log deadlock to DB
            pool.query(`
                INSERT INTO deadlock_log (transaction1, transaction2, victim, seat_involved, resolution, sql_state, detail)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [sessionId, 'other_session', sessionId, `seat_id=${seatId}`, 'rollback', e.code, e.message]).catch(() => {});

            broadcast({ 
                type: 'deadlock_detected', 
                sessionId, 
                seatId,
                sqlState: e.code,
                message: `💀 DEADLOCK! Giao dịch ${sessionId} bị PostgreSQL rollback!`,
                detail: e.message
            });

            // Clean up the session since it was rolled back
            try { session.client.release(); } catch(e2) {}
            activeSessions.delete(sessionId);
        }

        res.status(isDeadlock ? 409 : 500).json({ 
            success: false, 
            isDeadlock,
            sqlState: e.code,
            message: e.message,
            errorMsg
        });
    }
});

/**
 * Step 3: Commit transaction - book the seats
 */
app.post('/api/tx/commit', async (req, res) => {
    const { sessionId, customerName, customerPhone } = req.body;

    const session = activeSessions.get(sessionId);
    if (!session) {
        return res.status(400).json({ success: false, message: 'Session not found' });
    }

    session.step++;
    const t0 = Date.now();

    try {
        const name = customerName || session.customerName || 'Customer';
        const phone = customerPhone || '0900000000';
        const bookingIds = [];

        // Update seat status and create bookings for all locked seats
        for (const seatId of session.lockedSeats) {
            const seatResult = await session.client.query(
                `SELECT id, seat_row, seat_number, seat_type, price, showtime_id FROM seats WHERE id = $1`,
                [seatId]
            );
            const seat = seatResult.rows[0];

            await session.client.query(`
                UPDATE seats 
                SET status = 'booked', 
                    locked_by = $1, 
                    locked_at = NOW()
                WHERE id = $2
            `, [sessionId, seatId]);

            sqlLog(sessionId, sessionId, session.step,
                `UPDATE seats SET status = 'booked', locked_by = '${sessionId}' WHERE id = ${seatId};`,
                `Cập nhật ghế ${seat.seat_row}${seat.seat_number} -> booked`, 'success', 0);

            const bookingResult = await session.client.query(`
                INSERT INTO bookings (transaction_id, showtime_id, seat_id, customer_name, customer_phone, total_price)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
            `, [sessionId, seat.showtime_id, seatId, name, phone, seat.price]);

            sqlLog(sessionId, sessionId, session.step,
                `INSERT INTO bookings (transaction_id, showtime_id, seat_id, customer_name, customer_phone, total_price) VALUES ('${sessionId}', ${seat.showtime_id}, ${seatId}, '${name}', '${phone}', ${seat.price});`,
                `Tạo booking #${bookingResult.rows[0].id}`, 'success', 0);

            bookingIds.push(bookingResult.rows[0].id);
        }

        // COMMIT
        await session.client.query('COMMIT');
        const dur = Date.now() - t0;

        sqlLog(sessionId, sessionId, session.step,
            `COMMIT; -- Giao dịch ${sessionId} hoàn thành thành công!`,
            `✅ COMMIT thành công! Bookings: ${bookingIds.join(', ')}`, 'success', dur);

        session.client.release();
        activeSessions.delete(sessionId);

        broadcast({ 
            type: 'tx_committed', 
            sessionId, 
            bookingIds,
            seats: session.lockedSeats,
            message: `✅ [${sessionId}] COMMIT thành công! Đã đặt ${session.lockedSeats.length} ghế.` 
        });

        res.json({ 
            success: true, 
            bookingIds,
            seatsBooked: session.lockedSeats.length,
            message: `Đặt vé thành công! Booking IDs: ${bookingIds.join(', ')}` 
        });

    } catch (e) {
        const dur = Date.now() - t0;
        sqlLog(sessionId, sessionId, session.step,
            'COMMIT;', `❌ Lỗi COMMIT: ${e.message}`, 'error', dur);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * Rollback transaction
 */
app.post('/api/tx/rollback', async (req, res) => {
    const { sessionId, reason } = req.body;

    const session = activeSessions.get(sessionId);
    if (!session) {
        return res.json({ success: true, message: 'Session already ended' });
    }

    session.step++;
    const t0 = Date.now();

    try {
        await session.client.query('ROLLBACK');
        const dur = Date.now() - t0;

        sqlLog(sessionId, sessionId, session.step,
            `ROLLBACK; -- ${reason || 'Manual rollback'}`,
            '⚠️ Giao dịch đã bị rollback, tất cả khóa được giải phóng', 'error', dur);

        session.client.release();
        activeSessions.delete(sessionId);

        broadcast({ 
            type: 'tx_rolled_back', 
            sessionId,
            message: `⚠️ [${sessionId}] ROLLBACK - Tất cả ghế đã được giải phóng` 
        });

        res.json({ success: true, message: 'Transaction rolled back' });

    } catch (e) {
        try { session.client.release(); } catch(e2) {}
        activeSessions.delete(sessionId);
        res.json({ success: true, message: 'Session cleaned up' });
    }
});

/**
 * Get session status
 */
app.get('/api/tx/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (!session) {
        return res.json({ active: false, sessionId });
    }

    res.json({
        active: true,
        sessionId,
        step: session.step,
        lockedSeats: session.lockedSeats,
        customerName: session.customerName
    });
});

/**
 * Fix deadlock: Set lock_timeout and use advisory locks for ordering
 * (Deadlock Prevention via Ordered Locking)
 */
app.post('/api/tx/fix-book', async (req, res) => {
    const { seatIds, customerName, customerPhone, method } = req.body;
    const fixTxId = 'FIX-' + uuidv4().slice(0, 8).toUpperCase();

    const client = await pool.connect();
    const steps = [];

    try {
        sqlLog(fixTxId, fixTxId, 1,
            `-- ✅ FIX METHOD: ${method || 'Ordered Locking'}\n-- Đặt khóa theo thứ tự tăng dần của seat_id để tránh deadlock`,
            'Bắt đầu giao dịch an toàn', 'info', 0);

        await client.query(`SET lock_timeout = '5s'`);
        await client.query(`SET deadlock_timeout = '1s'`);
        await client.query('BEGIN');

        sqlLog(fixTxId, fixTxId, 2,
            `SET lock_timeout = '5s';\nSET deadlock_timeout = '1s';\nBEGIN;`,
            'Transaction started', 'success', 0);

        // KEY FIX: Sort seat IDs to ensure consistent locking order
        // This prevents deadlock by ensuring T1 and T2 always lock in same order
        const sortedSeatIds = [...seatIds].sort((a, b) => a - b);

        sqlLog(fixTxId, fixTxId, 3,
            `-- 🔑 Sắp xếp seat IDs theo thứ tự tăng dần: [${sortedSeatIds.join(', ')}]\n-- Đây là chìa khóa ngăn deadlock (Ordered Locking Protocol)`,
            `Thứ tự khóa: ${sortedSeatIds.join(' -> ')}`, 'info', 0);

        const bookedSeats = [];
        const bookingIds = [];

        for (let i = 0; i < sortedSeatIds.length; i++) {
            const seatId = sortedSeatIds[i];
            const t0 = Date.now();

            const lockSql = `SELECT id, seat_row, seat_number, seat_type, price, showtime_id, status
FROM seats 
WHERE id = ${seatId}
FOR UPDATE;  -- Khóa theo thứ tự an toàn`;

            const result = await client.query(`
                SELECT id, seat_row, seat_number, seat_type, price, showtime_id, status
                FROM seats WHERE id = $1 FOR UPDATE
            `, [seatId]);

            const dur = Date.now() - t0;
            const seat = result.rows[0];

            if (seat.status === 'booked') {
                throw new Error(`Ghế ${seat.seat_row}${seat.seat_number} đã được đặt`);
            }

            sqlLog(fixTxId, fixTxId, 4 + i,
                lockSql, `✅ Khóa thành công ghế ${seat.seat_row}${seat.seat_number}`, 'success', dur);

            bookedSeats.push(seat);
        }

        // Update and insert bookings
        for (let i = 0; i < sortedSeatIds.length; i++) {
            const seat = bookedSeats[i];

            await client.query(`
                UPDATE seats SET status = 'booked', locked_by = $1, locked_at = NOW()
                WHERE id = $2
            `, [fixTxId, seat.id]);

            const bookingResult = await client.query(`
                INSERT INTO bookings (transaction_id, showtime_id, seat_id, customer_name, customer_phone, total_price)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
            `, [fixTxId, seat.showtime_id, seat.id, customerName || 'Customer', customerPhone || '0900000000', seat.price]);

            bookingIds.push(bookingResult.rows[0].id);

            sqlLog(fixTxId, fixTxId, 4 + sortedSeatIds.length + i,
                `UPDATE seats SET status = 'booked' WHERE id = ${seat.id};\nINSERT INTO bookings (...) VALUES ('${fixTxId}', ${seat.showtime_id}, ${seat.id}, ...);`,
                `Booking #${bookingResult.rows[0].id} created`, 'success', 0);
        }

        await client.query('COMMIT');

        sqlLog(fixTxId, fixTxId, 10,
            `COMMIT; -- Hoàn thành! Không có deadlock xảy ra nhờ Ordered Locking`,
            `✅ COMMIT thành công! Booking IDs: ${bookingIds.join(', ')}`, 'success', 0);

        broadcast({ 
            type: 'fix_committed', 
            fixTxId, 
            bookingIds,
            message: `✅ [FIX] Đặt vé thành công với Ordered Locking! Không có deadlock.` 
        });

        client.release();

        res.json({ 
            success: true, 
            bookingIds,
            fixTxId,
            method: 'Ordered Locking - Đặt khóa theo thứ tự ID tăng dần',
            message: `Đặt vé thành công! ${bookingIds.length} ghế đã được đặt.` 
        });

    } catch (e) {
        try { await client.query('ROLLBACK'); } catch(e2) {}
        client.release();

        sqlLog(fixTxId, fixTxId, 99,
            'ROLLBACK;', `❌ Lỗi: ${e.message}`, 'error', 0);

        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// Start Server
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎬 Cinema Deadlock Demo Backend running on port ${PORT}`);
    console.log(`📡 WebSocket server on ws://localhost:${PORT}/ws`);
    console.log(`🗄️  Database: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
});
