package app

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// The relay owns provider authentication. The account service owns all profile,
// billing and usage records. Only an authenticated, stable relay identity can
// create that association; names and email addresses are never linking keys.
type communityIdentity struct {
	ID       string  `json:"id"`
	Provider string  `json:"provider"`
	Name     string  `json:"name"`
	Username *string `json:"username,omitempty"`
}

var communityHTTP = &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

func (a *App) communitySession(r *http.Request) (M, error) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") || len(header) < 24 || len(header) > 4096 {
		return nil, nil
	}
	hash := signature(a.Config.Secret, a.token(r))
	if row := one(a.Store.DB, "SELECT revoked FROM community_sessions WHERE hash=?", hash); row != nil && row["revoked"] == true {
		return nil, nil
	}
	req, err := http.NewRequestWithContext(r.Context(), "GET", a.Config.CommunityAuthURL+"/v1/community/account", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", header)
	response, err := communityHTTP.Do(req)
	if err != nil {
		return nil, problemBoth(503, "登录服务暂时无法连接，请稍后再试", "Sign-in service is temporarily unavailable. Please try again shortly.")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 {
		return nil, nil
	}
	if response.StatusCode != 200 {
		return nil, problemBoth(503, "登录服务暂不可用", "Sign-in service is temporarily unavailable")
	}
	var identity communityIdentity
	decoder := json.NewDecoder(io.LimitReader(response.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&identity) != nil || decoder.Decode(new(any)) != io.EOF || identity.ID == "" || len(identity.ID) > 128 || len(identity.Name) > 256 || (identity.Provider != "google" && identity.Provider != "github" && identity.Provider != "nodeloc") {
		return nil, problem(503, "登录服务返回的数据不完整")
	}
	var user M
	err = a.Store.Tx("community-identity:"+identity.ID, func(tx *sql.Tx) error {
		mapping := one(tx, "SELECT user_id FROM community_users WHERE identity_id=?", identity.ID)
		uid := str(mapping["user_id"])
		if uid == "" {
			uid = id()
			exec(tx, "INSERT INTO users(id,created,display_name) VALUES(?,?,?)", uid, now(), identity.Name)
			exec(tx, "INSERT INTO community_users(identity_id,provider,user_id) VALUES(?,?,?)", identity.ID, identity.Provider, uid)
		}
		user = one(tx, "SELECT * FROM users WHERE id=?", uid)
		username := ""
		if identity.Username != nil {
			username = *identity.Username
		}
		if username != str(user["username"]) {
			if username != "" && !usernamePattern.MatchString(username) {
				return problem(503, "登录服务返回的数据不完整")
			}
			if username == "" {
				exec(tx, "UPDATE users SET username=NULL WHERE id=?", uid)
			} else {
				exec(tx, "UPDATE users SET username=? WHERE id=?", username, uid)
			}
			user["username"] = username
		}
		if num(user["disabled"]) != 0 {
			user = nil
			return nil
		}
		exec(tx, "INSERT INTO community_sessions(hash,user_id) VALUES(?,?) ON CONFLICT(hash) DO NOTHING", hash, uid)
		if row := one(tx, "SELECT revoked FROM community_sessions WHERE hash=?", hash); row["revoked"] == true {
			user = nil
		}
		return nil
	})
	return user, err
}
