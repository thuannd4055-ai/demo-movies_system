-- ============================================================
-- CINEMA DEADLOCK DEMO - DATABASE INITIALIZATION
-- DBMS Course - Deadlock Demonstration
-- ============================================================

-- Enable pg_stat_activity for monitoring
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ============================================================
-- TABLE: movies - Danh sách phim
-- ============================================================
CREATE TABLE IF NOT EXISTS movies (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    duration    INTEGER NOT NULL, -- minutes
    genre       VARCHAR(50),
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLE: showtimes - Lịch chiếu
-- ============================================================
CREATE TABLE IF NOT EXISTS showtimes (
    id          SERIAL PRIMARY KEY,
    movie_id    INTEGER REFERENCES movies(id),
    show_date   DATE NOT NULL,
    show_time   TIME NOT NULL,
    hall        VARCHAR(20) NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLE: seats - Ghế ngồi (mỗi phòng chiếu)
-- ============================================================
CREATE TABLE IF NOT EXISTS seats (
    id          SERIAL PRIMARY KEY,
    showtime_id INTEGER REFERENCES showtimes(id),
    seat_row    CHAR(1) NOT NULL,   -- A, B, C...
    seat_number INTEGER NOT NULL,   -- 1, 2, 3...
    seat_type   VARCHAR(20) DEFAULT 'normal', -- normal, vip, couple
    status      VARCHAR(20) DEFAULT 'available', -- available, locked, booked
    locked_by   VARCHAR(100),       -- transaction ID holding the lock
    locked_at   TIMESTAMP,
    price       DECIMAL(10,2) DEFAULT 75000,
    UNIQUE(showtime_id, seat_row, seat_number)
);

-- ============================================================
-- TABLE: bookings - Đặt vé
-- ============================================================
CREATE TABLE IF NOT EXISTS bookings (
    id              SERIAL PRIMARY KEY,
    transaction_id  VARCHAR(100) NOT NULL,
    showtime_id     INTEGER REFERENCES showtimes(id),
    seat_id         INTEGER REFERENCES seats(id),
    customer_name   VARCHAR(100) NOT NULL,
    customer_phone  VARCHAR(20),
    status          VARCHAR(20) DEFAULT 'confirmed', -- confirmed, cancelled
    total_price     DECIMAL(10,2),
    booked_at       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLE: deadlock_log - Ghi log deadlock events
-- ============================================================
CREATE TABLE IF NOT EXISTS deadlock_log (
    id              SERIAL PRIMARY KEY,
    detected_at     TIMESTAMP DEFAULT NOW(),
    transaction1    VARCHAR(200),
    transaction2    VARCHAR(200),
    victim          VARCHAR(200),
    seat_involved   VARCHAR(100),
    resolution      VARCHAR(50),
    sql_state       VARCHAR(20),
    detail          TEXT
);

-- ============================================================
-- TABLE: transaction_log - Ghi log từng bước SQL
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_log (
    id              SERIAL PRIMARY KEY,
    session_id      VARCHAR(100),
    transaction_id  VARCHAR(100),
    step_number     INTEGER,
    sql_command     TEXT NOT NULL,
    result          TEXT,
    status          VARCHAR(20), -- success, error, waiting, deadlock
    executed_at     TIMESTAMP DEFAULT NOW(),
    duration_ms     INTEGER
);

-- ============================================================
-- INSERT SAMPLE DATA
-- ============================================================

INSERT INTO movies (title, duration, genre) VALUES
('Avengers: Secret Wars', 150, 'Action'),
('Dune: Part Three', 165, 'Sci-Fi'),
('Spider-Man: Beyond the Spider-Verse', 130, 'Animation');

INSERT INTO showtimes (movie_id, show_date, show_time, hall) VALUES
(1, CURRENT_DATE, '19:00', 'Hall A'),
(1, CURRENT_DATE, '21:30', 'Hall B'),
(2, CURRENT_DATE, '18:00', 'Hall A'),
(2, CURRENT_DATE + 1, '20:00', 'Hall C');

-- Generate seats for showtime 1 (Hall A - 6x8 = 48 seats)
DO $$
DECLARE
    rows CHAR[] := ARRAY['A','B','C','D','E','F'];
    r CHAR;
    n INTEGER;
    s_type VARCHAR(20);
    s_price DECIMAL(10,2);
BEGIN
    FOREACH r IN ARRAY rows LOOP
        FOR n IN 1..8 LOOP
            IF r IN ('E','F') THEN
                s_type := 'vip';
                s_price := 120000;
            ELSIF r = 'F' AND n IN (3,4,5,6) THEN
                s_type := 'couple';
                s_price := 200000;
            ELSE
                s_type := 'normal';
                s_price := 75000;
            END IF;
            INSERT INTO seats (showtime_id, seat_row, seat_number, seat_type, price)
            VALUES (1, r, n, s_type, s_price);
        END LOOP;
    END LOOP;
END $$;

-- Generate seats for showtime 2
DO $$
DECLARE
    rows CHAR[] := ARRAY['A','B','C','D','E','F'];
    r CHAR;
    n INTEGER;
BEGIN
    FOREACH r IN ARRAY rows LOOP
        FOR n IN 1..8 LOOP
            INSERT INTO seats (showtime_id, seat_row, seat_number, seat_type, price)
            VALUES (2, r, n, 'normal', 75000);
        END LOOP;
    END LOOP;
END $$;

-- ============================================================
-- STORED PROCEDURE: Book seat with explicit locking (causes deadlock)
-- ============================================================
CREATE OR REPLACE FUNCTION book_seat_with_lock(
    p_transaction_id    VARCHAR,
    p_seat_id           INTEGER,
    p_customer_name     VARCHAR,
    p_customer_phone    VARCHAR
) RETURNS JSON AS $$
DECLARE
    v_seat          seats%ROWTYPE;
    v_booking_id    INTEGER;
    v_result        JSON;
BEGIN
    -- SELECT FOR UPDATE: Đặt khóa ghi (Write Lock) lên ghế
    -- Đây là lệnh SQL quan trọng tạo ra cơ chế khóa
    SELECT * INTO v_seat
    FROM seats
    WHERE id = p_seat_id
    FOR UPDATE;  -- WRITE LOCK - Khóa độc quyền

    -- Kiểm tra trạng thái ghế
    IF v_seat.status = 'booked' THEN
        RAISE EXCEPTION 'SEAT_ALREADY_BOOKED: Ghế đã được đặt bởi người khác';
    END IF;

    IF v_seat.status = 'locked' AND v_seat.locked_by != p_transaction_id THEN
        RAISE EXCEPTION 'SEAT_LOCKED: Ghế đang bị khóa bởi giao dịch khác: %', v_seat.locked_by;
    END IF;

    -- Cập nhật trạng thái ghế thành 'booked'
    UPDATE seats
    SET status = 'booked',
        locked_by = p_transaction_id,
        locked_at = NOW()
    WHERE id = p_seat_id;

    -- Tạo booking record
    INSERT INTO bookings (transaction_id, showtime_id, seat_id, customer_name, customer_phone, total_price)
    VALUES (p_transaction_id, v_seat.showtime_id, p_seat_id, p_customer_name, p_customer_phone, v_seat.price)
    RETURNING id INTO v_booking_id;

    v_result := json_build_object(
        'success', true,
        'booking_id', v_booking_id,
        'seat', v_seat.seat_row || v_seat.seat_number,
        'price', v_seat.price,
        'message', 'Đặt vé thành công!'
    );

    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- STORED PROCEDURE: Lock seat (tạm khóa để tạo deadlock)
-- ============================================================
CREATE OR REPLACE FUNCTION lock_seat_for_transaction(
    p_transaction_id    VARCHAR,
    p_seat_id           INTEGER
) RETURNS JSON AS $$
DECLARE
    v_seat  seats%ROWTYPE;
BEGIN
    -- SELECT FOR UPDATE NOWAIT: Khóa ngay, không chờ
    SELECT * INTO v_seat
    FROM seats
    WHERE id = p_seat_id
    FOR UPDATE NOWAIT;

    UPDATE seats
    SET status = 'locked',
        locked_by = p_transaction_id,
        locked_at = NOW()
    WHERE id = p_seat_id;

    RETURN json_build_object(
        'success', true,
        'seat_id', p_seat_id,
        'seat', v_seat.seat_row || v_seat.seat_number,
        'message', 'Đã khóa ghế thành công'
    );
EXCEPTION
    WHEN lock_not_available THEN
        RAISE EXCEPTION 'LOCK_CONFLICT: Ghế đang bị khóa bởi giao dịch khác';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VIEW: Active locks monitor
-- ============================================================
CREATE OR REPLACE VIEW v_active_locks AS
SELECT
    pid,
    usename,
    application_name,
    state,
    wait_event_type,
    wait_event,
    query_start,
    NOW() - query_start AS duration,
    LEFT(query, 100) AS query_preview,
    backend_xid,
    backend_xmin
FROM pg_stat_activity
WHERE state != 'idle'
  AND query NOT LIKE '%pg_stat_activity%'
ORDER BY query_start;

-- ============================================================
-- VIEW: Seat status overview
-- ============================================================
CREATE OR REPLACE VIEW v_seat_status AS
SELECT
    s.id,
    s.showtime_id,
    s.seat_row || s.seat_number AS seat_label,
    s.seat_type,
    s.status,
    s.locked_by,
    s.locked_at,
    s.price,
    m.title AS movie_title,
    st.show_time,
    st.hall
FROM seats s
JOIN showtimes st ON s.showtime_id = st.id
JOIN movies m ON st.movie_id = m.id;

-- ============================================================
-- FUNCTION: Detect deadlock in wait-for graph
-- ============================================================
CREATE OR REPLACE FUNCTION detect_deadlock_graph()
RETURNS TABLE (
    waiting_pid     INTEGER,
    waiting_query   TEXT,
    blocking_pid    INTEGER,
    blocking_query  TEXT,
    lock_type       TEXT,
    relation        TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        w.pid::INTEGER                              AS waiting_pid,
        LEFT(w.query, 200)                          AS waiting_query,
        b.pid::INTEGER                              AS blocking_pid,
        LEFT(b.query, 200)                          AS blocking_query,
        l.locktype                                  AS lock_type,
        COALESCE(c.relname, l.locktype)             AS relation
    FROM pg_stat_activity w
    JOIN pg_locks l          ON l.pid = w.pid AND NOT l.granted
    JOIN pg_locks bl         ON bl.locktype = l.locktype
                             AND bl.database IS NOT DISTINCT FROM l.database
                             AND bl.relation IS NOT DISTINCT FROM l.relation
                             AND bl.page IS NOT DISTINCT FROM l.page
                             AND bl.tuple IS NOT DISTINCT FROM l.tuple
                             AND bl.transactionid IS NOT DISTINCT FROM l.transactionid
                             AND bl.classid IS NOT DISTINCT FROM l.classid
                             AND bl.objid IS NOT DISTINCT FROM l.objid
                             AND bl.objsubid IS NOT DISTINCT FROM l.objsubid
                             AND bl.pid != l.pid
                             AND bl.granted
    JOIN pg_stat_activity b  ON b.pid = bl.pid
    LEFT JOIN pg_class c     ON c.oid = l.relation
    WHERE w.state = 'active'
      AND w.wait_event_type = 'Lock';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCTION: Reset demo (xóa dữ liệu test)
-- ============================================================
CREATE OR REPLACE FUNCTION reset_demo()
RETURNS TEXT AS $$
BEGIN
    UPDATE seats SET status = 'available', locked_by = NULL, locked_at = NULL
    WHERE showtime_id IN (1, 2);

    DELETE FROM bookings WHERE booked_at > NOW() - INTERVAL '1 day';
    DELETE FROM deadlock_log WHERE detected_at > NOW() - INTERVAL '1 day';
    DELETE FROM transaction_log WHERE executed_at > NOW() - INTERVAL '1 day';

    RETURN 'Demo reset thành công! Tất cả ghế đã được giải phóng.';
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT ALL ON ALL TABLES IN SCHEMA public TO cinema_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cinema_user;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO cinema_user;

-- Log initialization
INSERT INTO transaction_log (session_id, transaction_id, step_number, sql_command, result, status)
VALUES ('system', 'INIT', 0, '-- Database initialized successfully', 'OK', 'success');
