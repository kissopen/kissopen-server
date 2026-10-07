package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type M map[string]any

func id() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func now() int64 { return time.Now().UnixMilli() }
func js(v any) string {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return string(b)
}
func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func num(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case float64:
		return int64(n)
	}
	return 0
}

type querier interface {
	Exec(string, ...any) (sql.Result, error)
	Query(string, ...any) (*sql.Rows, error)
}

func exec(q querier, s string, a ...any) int64 {
	r, e := q.Exec(rebind(s), a...)
	if e != nil {
		panic(e)
	}
	n, e := r.RowsAffected()
	if e != nil {
		panic(e)
	}
	return n
}
func all(q querier, s string, a ...any) []M {
	r, e := q.Query(rebind(s), a...)
	if e != nil {
		panic(e)
	}
	defer r.Close()
	cols, e := r.Columns()
	if e != nil {
		panic(e)
	}
	out := []M{}
	for r.Next() {
		vs := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range vs {
			ptr[i] = &vs[i]
		}
		if e = r.Scan(ptr...); e != nil {
			panic(e)
		}
		m := M{}
		for i, c := range cols {
			if b, ok := vs[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = vs[i]
			}
		}
		out = append(out, m)
	}
	if e = r.Err(); e != nil {
		panic(e)
	}
	return out
}
func one(q querier, s string, a ...any) M {
	rs := all(q, s, a...)
	if len(rs) == 0 {
		return nil
	}
	return rs[0]
}

// Store is the database plus the directory pictures live in. Pictures are
// files, not rows: they are most of the bytes and none of the queries, and a
// row holding them made every backup, copy and vacuum carry them along.
type Store struct {
	DB *sql.DB
	// Where pictures' bytes are: a directory, or a bucket. See blobs.go.
	Blobs Blobs
}

/*
What a transaction locks before it runs.

Transactions read, decide and then write — a rate limit, an idempotency check,
a budget, a window — and those decisions are only sound if nothing changes what
was read in between. Every transaction therefore names what it is about and
takes that one advisory lock for its duration: an account's own work (a chat,
its cancel, the worker writing the answer, the settle) serializes with itself
and with nothing else, and the few things that are nobody's in particular —
claiming the next job, recovery, the delivery outbox, a rate-limit row, a
phone signing in — have keys of their own. Two accounts never wait on each
other, and two workers only meet at the claim.

Single statements outside a transaction take nothing; each is atomic on its
own. One key per transaction, always, so no two can wait on each other.
*/
const (
	// Schema changes at startup, so two processes coming up together do not
	// both try to create the same table.
	lockSchema = "schema"
)

func userKey(user string) string { return "user:" + user }

func lockRate(key string) string { return "rate:" + key }

// lockKey is the 64-bit advisory lock a key names. A collision only makes two
// unrelated transactions wait on each other, never lets two related ones run.
func lockKey(key string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	return int64(h.Sum64())
}

// Tx runs fn in one transaction that holds the lock for key throughout.
func (s *Store) Tx(key string, fn func(*sql.Tx) error) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("SELECT pg_advisory_xact_lock($1)", lockKey(key)); e != nil {
		return e
	}
	if e = fn(tx); e != nil {
		return e
	}
	return tx.Commit()
}

// schemaApply runs the schema on one connection while holding the schema
// lock, so processes starting together take turns.
func schemaApply(db *sql.DB, statements ...string) error {
	conn, e := db.Conn(context.Background())
	if e != nil {
		return e
	}
	defer conn.Close()
	if _, e = conn.ExecContext(context.Background(), "SELECT pg_advisory_lock($1)", lockKey(lockSchema)); e != nil {
		return e
	}
	defer conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock($1)", lockKey(lockSchema))
	for _, statement := range statements {
		if _, e = conn.ExecContext(context.Background(), statement); e != nil {
			return e
		}
	}
	return nil
}

// ImageWrite stores a picture's bytes and returns the key the row keeps. The
// key is spelled with slashes whichever backing holds it, so a row written
// against a directory still opens once the pictures have moved to a bucket.
func (s *Store) ImageWrite(id, mime string, data []byte) (string, error) {
	key := id[:2] + "/" + id + imageExtension(mime)
	return key, s.Blobs.Put(key, mime, data)
}

func (s *Store) imageRead(key string) ([]byte, error) {
	return s.Blobs.Get(filepath.ToSlash(key))
}

// rebind turns the `?` placeholders every query here is written with into
// PostgreSQL's numbered ones. Queries are literals in this package, so the
// only `?` that is not a placeholder would sit inside a quoted string, and
// those are skipped.
func rebind(q string) string {
	if !strings.Contains(q, "?") {
		return q
	}
	var b strings.Builder
	b.Grow(len(q) + 16)
	n, quoted := 0, false
	for i := 0; i < len(q); i++ {
		c := q[i]
		switch {
		case c == '\'':
			quoted = !quoted
		case c == '?' && !quoted:
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}
