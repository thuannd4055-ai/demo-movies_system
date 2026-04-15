const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

const config = {
    user: 'sa',
    password: 'PhuongNgan@2026', 
    server: 'localhost',
    port: 1433,
    database: 'movie_booking', 
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// HÀM HỖ TRỢ RETRY KHI GẶP DEADLOCK
// ==========================================
async function executeWithRetry(action, transactionName) {
    let attempts = 0;
    while (attempts < 3) {
        try {
            return await action();
        } catch (err) {
            console.log(`Lỗi bắt được: ${err.message}`);
            const isDeadlock = err.number === 1205 || 
                           err.message.toLowerCase().includes('deadlock') || 
                           err.message.toLowerCase().includes('aborted');
            if (err.number === 1205) { 
                attempts++;
                console.log(`[${transactionName}] Deadlock detected!`);
                console.log(`[${transactionName}] Retrying transaction (Attempt ${attempts})...`);
                await sleep(1000); 
            } else {
                throw err;
            }
        }
    }
    throw new Error("Giao dịch thất bại sau nhiều lần thử lại do Deadlock.");
}

// ==========================================
// 1. API HỆ THỐNG ĐẶT VÉ
// ==========================================

app.get('/api/movies', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request().query('SELECT * FROM Movie');
        res.json(result.recordset);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/seats', async (req, res) => {
    const { showtime_id } = req.query;
    try {
        let pool = await sql.connect(config);
        let result = await pool.request().query(`SELECT * FROM Seat WHERE showtime_id = ${showtime_id}`);
        res.json(result.recordset);
    } catch (err) { res.status(500).send(err.message); }
});

// Logic: Reserve ghế (Available -> Reserved)
app.post('/api/reserve', async (req, res) => {
    const { seat_id } = req.body;
    try {
        await executeWithRetry(async () => {
            let pool = await sql.connect(config);
            const transaction = new sql.Transaction(pool);
            await transaction.begin();
            try {
                // Khóa ghế để kiểm tra
                const result = await transaction.request().query(`SELECT * FROM Seat WITH (UPDLOCK, ROWLOCK) WHERE id = ${seat_id}`);
                const seat = result.recordset[0];

                if (seat.status !== 'available') throw new Error('Ghế không còn trống');

                await transaction.request().query(`UPDATE Seat SET status = 'reserved' WHERE id = ${seat_id}`);
                await transaction.commit();
                console.log(`Seat A${seat_id} reserved`);
                res.json({ success: true });
            } catch (innerErr) {
                await transaction.rollback();
                throw innerErr;
            }
        }, "Reserve");
    } catch (err) { res.status(400).send(err.message); }
});

// Logic: Confirm (Reserved -> Booked + Insert Booking)
app.post('/api/confirm', async (req, res) => {
    const { seat_id, user_name, showtime_id } = req.body;
    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            await transaction.request().query(`UPDATE Seat SET status = 'booked' WHERE id = ${seat_id}`);
            await transaction.request().query(`INSERT INTO Booking (user_name, showtime_id, seat_id) VALUES (N'${user_name}', ${showtime_id}, ${seat_id})`);
            await transaction.commit();
            console.log(`Seat A${seat_id} booked by ${user_name}`);
            res.json({ success: true });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// 2. KỊCH BẢN DEADLOCK (SCENARIO 1)
// ==========================================

app.get('/api/t1', async (req, res) => {
    try {
        await executeWithRetry(async () => {
            let pool = await sql.connect(config);
            const transaction = new sql.Transaction(pool);
            await transaction.begin();
            try {
                console.log('Mia locked Seat A1');
                await transaction.request().query('SELECT * FROM Seat WITH (UPDLOCK, ROWLOCK) WHERE id = 1');
                
                await sleep(5000); 
                
                console.log('Mia waiting for Seat A2');
                await transaction.request().query('SELECT * FROM Seat WITH (UPDLOCK, ROWLOCK) WHERE id = 2');
                
                await transaction.request().query("UPDATE Seat SET status = 'booked' WHERE id = 1");
                
                await transaction.commit();
                console.log('Mia booked Seat A1 successfully!');
                res.send('Mia Success - Seat A1 is now booked');
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        }, "Mia");
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/t2', async (req, res) => {
    try {
        await executeWithRetry(async () => {
            let pool = await sql.connect(config);
            const transaction = new sql.Transaction(pool);
            await transaction.begin();
            try {
                console.log('Jack locked Seat A2');
                await transaction.request().query('SELECT * FROM Seat WITH (UPDLOCK, ROWLOCK) WHERE id = 2');
                
                await sleep(5000);
                
                console.log('Jack waiting for Seat A1');
                await transaction.request().query('SELECT * FROM Seat WITH (UPDLOCK, ROWLOCK) WHERE id = 1');
                
                await transaction.request().query("UPDATE Seat SET status = 'booked' WHERE id = 2");
                
                await transaction.commit();
                console.log('Jack booked Seat A2 successfully!');
                res.send('Jack Success - Seat A2 is now booked');
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        }, "Jack");
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// 3. API FIX (Dùng Lock Ordering)
// ==========================================
app.post('/api/fix', async (req, res) => {
    let { seat_ids, user_name } = req.body; 
    seat_ids.sort((a, b) => a - b); 

    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            for (let id of seat_ids) {
                console.log(`Fix: Locking Seat A${id}`);
                await transaction.request().query(`SELECT * FROM Seat WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`);
                await sleep(1000);
            }
            for (let id of seat_ids) {
                await transaction.request().query(`UPDATE Seat SET status = 'booked' WHERE id = ${id}`);
            }
            await transaction.commit();
            res.send('Fix Success - No Deadlock Possible');
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(3000, () => console.log('Backend đang chạy tại port 3000...'));