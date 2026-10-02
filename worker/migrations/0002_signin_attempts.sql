-- Failed sign-in attempts, counted per client address.
--
-- The sign-in route hashes with scrypt on purpose, which costs about 55ms of CPU
-- on the development machine. That is what makes a stolen hash expensive to crack
-- and it is also what makes an unthrottled endpoint a CPU-burner. This table is
-- what lets lib/throttle.js stop answering after too many failures.
--
-- It stores nothing about who was signing in - no email, no user agent, no
-- address that identifies a person - only a client IP and two integers. Keeping
-- it that way is deliberate: a throttle table that accumulates personal data
-- becomes the thing that needs protecting.

CREATE TABLE IF NOT EXISTS signin_attempts (
    ip       TEXT    PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    last_at  INTEGER NOT NULL
);

-- Rows are only ever read as "the client this address belongs to". Nothing
-- joins against this table, so no index beyond the primary key is needed.