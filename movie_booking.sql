-- 1. Tạo database
CREATE DATABASE movie_booking;
GO

-- 2. Sử dụng database vừa tạo
USE movie_booking;
GO

-- 3. Tạo bảng Seat để demo Deadlock
CREATE TABLE Seat (
    id INT PRIMARY KEY,
    status NVARCHAR(50) -- available, reserved, booked
);

-- 4. Thêm dữ liệu mẫu (Cực kỳ quan trọng để chạy api/t1 và t2)
INSERT INTO Seat (id, status) VALUES (1, 'available');
INSERT INTO Seat (id, status) VALUES (2, 'available');
SELECT * FROM Seat;
