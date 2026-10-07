package app

import (
	"crypto/hmac"

	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"

	"io"
	"log"

	"net/http"

	"strings"

	"time"

	"kissopen.local/accounts/internal/api"
)

type apiError struct {
	Status  int
	Message string
	Code    string
	ResetAt int64
	// English written with the message, for the few built from live values;
	// fixed messages find theirs in messagesEN.
	English string
}

func (e *apiError) Error() string          { return e.Message }
func problem(status int, msg string) error { return &apiError{Status: status, Message: msg} }

// problemBoth is a message built from live values, so its English is written
// alongside it rather than looked up.
func problemBoth(status int, zh, en string) error {
	return &apiError{Status: status, Message: zh, English: en}
}
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(wire(data))
}
func fail(w http.ResponseWriter, r *http.Request, e error) {
	var p *apiError
	if !errors.As(e, &p) {
		log.Printf("request error: %v", e)
		p = &apiError{Status: 500, Message: "服务暂不可用，请稍后重试"}
	}
	if p.ResetAt > 0 {
		w.Header().Set("Retry-After", time.UnixMilli(p.ResetAt).UTC().Format(http.TimeFormat))
	}
	respond(w, p.Status, api.ErrorBody{Error: p.text(english(r)), Code: p.Code})
}

// bodyLimit is how large a request to this path may be. Most requests are a
// few kilobytes; the exceptions are named, each with its reason.
func bodyLimit(path string) int64 {
	if path == "/api/themes/images" {
		return int64(base64.StdEncoding.EncodedLen(themeImageMax) + 1024)
	}
	return 1 << 20
}

func read[T any](r *http.Request) (T, error) {
	var v T
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(&v); e != nil {
		// Too large is its own answer: a request cut off at the limit is
		// well-formed as far as its sender knows, and "malformed" sends them
		// looking in the wrong place.
		var tooLarge *http.MaxBytesError
		if errors.As(e, &tooLarge) {
			if r.URL.Path == "/api/themes/images" {
				return v, problemBoth(413, "背景图片不能超过 3 MB，请压缩图片或换一张后重试", "Choose a background picture up to 3 MB. Compress it or choose a smaller one, then try again.")
			}

			return v, problem(413, "请求内容过大")
		}

		log.Printf("request body rejected: %s %s content-length=%d: %v", r.Method, r.URL.Path, r.ContentLength, e)
		return v, problem(400, "请求格式不正确")
	}
	if d.Decode(new(any)) != io.EOF {
		return v, problem(400, "请求格式不正确")
	}
	return v, nil
}

func signature(secret, data string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

type handler func(http.ResponseWriter, *http.Request, string) error

func (a *App) route(pattern string, auth bool, h handler) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		user := ""
		if auth {
			row, err := a.communitySession(r)
			if err != nil {
				fail(w, r, err)
				return
			}
			if row == nil {
				fail(w, r, problem(401, "请先登录"))
				return
			}
			user = str(row["id"])
		}
		if e := h(w, r, user); e != nil {
			fail(w, r, e)
		}
	})
}
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if v := recover(); v != nil {
			log.Printf("request panic: %v", v)
			respond(w, 500, api.ErrorBody{Error: (&apiError{Message: "服务暂不可用"}).text(english(r))})
		}
	}()
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
		if origin := r.Header.Get("Origin"); origin != "" {
			if !a.allowedOrigin(origin) {
				fail(w, r, problem(403, "请求来源不被允许"))
				return
			}
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-KISSOPEN-Request, Last-Event-ID")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit(r.URL.Path))

	if r.Method != "GET" && r.Method != "HEAD" {
		if origin := r.Header.Get("Origin"); origin != "" && !a.allowedOrigin(origin) {
			fail(w, r, problem(403, "请求来源不被允许"))
			return
		}
		if r.Header.Get("X-KISSOPEN-Request") != "1" && !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			fail(w, r, problem(403, "缺少请求校验头"))
			return
		}
	}
	a.mux.ServeHTTP(w, r)
}
func (a *App) allowedOrigin(origin string) bool {
	if origin == a.Config.PublicURL {
		return true
	}
	for _, allowed := range a.Config.ClientOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}
func (a *App) token(r *http.Request) string {
	if v := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); v != r.Header.Get("Authorization") {
		return v
	}
	if c, e := r.Cookie("kissopen_session"); e == nil {
		return c.Value
	}
	return ""
}

func owned(q querier, table, item, user string) (M, error) {
	r := one(q, "SELECT * FROM "+table+" WHERE id=? AND user_id=?", item, user)
	if r == nil {
		return nil, problem(404, "内容不存在")
	}
	return r, nil
}
func (a *App) rate(key string, limit int, window time.Duration) bool {
	allowed := false
	e := a.Store.Tx(lockRate(key), func(tx *sql.Tx) error {
		r := one(tx, "SELECT * FROM rate_limits WHERE key=?", key)
		if r == nil || num(r["reset"]) <= now() {
			exec(tx, "INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=1,reset=excluded.reset", key, 1, now()+window.Milliseconds())
			allowed = true
		} else if num(r["count"]) < int64(limit) {
			exec(tx, "UPDATE rate_limits SET count=count+1 WHERE key=?", key)
			allowed = true
		}
		return nil
	})
	return e == nil && allowed
}

func maskPhone(p string) string {
	if len(p) < 9 {
		return p
	}
	return p[:5] + "****" + p[len(p)-4:]
}
