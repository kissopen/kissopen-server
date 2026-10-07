package app

import (
	"bytes"
	"crypto/hmac"
	"net/http"
	"strconv"
	"time"
)

const dayMillis = int64(24 * time.Hour / time.Millisecond)

// avatarURL is imageURL for an avatar: the same kind of self-permitting address,
// signed for avatars so one can never be replayed as the other.
func (a *App) avatarURL(id string) string { return a.signedURL("avatars", "avatar", id) }

func (a *App) signedURL(route, kind, id string) string {
	expires := (now()/dayMillis + 8) * dayMillis
	return a.Config.PublicURL + "/api/" + route + "/" + id + "?exp=" + strconv.FormatInt(expires, 10) + "&sig=" + a.signature(kind, id, expires)
}

func (a *App) signature(kind, id string, expires int64) string {
	return signature(a.Config.Secret, kind+":"+id+":"+strconv.FormatInt(expires, 10))[:32]
}

// signedExpiry checks a signed address and returns when it lapses, or 0 when it
// is missing, forged or expired.
func (a *App) signedExpiry(r *http.Request, kind, id string) int64 {
	sig := r.URL.Query().Get("sig")
	expires, _ := strconv.ParseInt(r.URL.Query().Get("exp"), 10, 64)
	if sig == "" || expires <= now() || !hmac.Equal([]byte(sig), []byte(a.signature(kind, id, expires))) {
		return 0
	}
	return expires
}

// avatar sends an avatar's bytes; only a signed address opens one.
func (a *App) avatar(w http.ResponseWriter, r *http.Request, _ string) error {
	id := r.PathValue("id")
	expires := a.signedExpiry(r, "avatar", id)
	if expires == 0 {
		return problem(404, "内容不存在")
	}
	row := one(a.Store.DB, "SELECT avatar_path,avatar_mime,created FROM users WHERE avatar_id=?", id)
	if row == nil {
		return problem(404, "内容不存在")
	}
	return a.serveStored(w, r, str(row["avatar_path"]), str(row["avatar_mime"]), num(row["created"]), expires)
}

// serveStored sends a stored picture. It never changes under its id, so it may
// be kept for as long as the address that fetched it is good.
func (a *App) serveStored(w http.ResponseWriter, r *http.Request, path, mime string, created, expires int64) error {
	data, e := a.Store.imageRead(path)
	if e != nil {
		return problem(404, "内容不存在")
	}
	w.Header().Set("Content-Type", mime)
	age := int64(3600)
	if expires > 0 {
		age = (expires - now()) / 1000
	}
	w.Header().Set("Cache-Control", "private, max-age="+strconv.FormatInt(age, 10)+", immutable")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeContent(w, r, "", time.UnixMilli(created), bytes.NewReader(data))
	return nil
}
