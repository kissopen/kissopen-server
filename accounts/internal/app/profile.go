package app

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"kissopen.local/accounts/internal/api"
)

// profileUser is the account as its own profile shows it. Not `owned`: that
// helper filters by a user_id column, and on `users` the row's own id is the
// account.
func (a *App) profileUser(q querier, u string) (api.ProfileUser, error) {
	row := one(q, "SELECT phone,created,display_name,COALESCE(username,'') AS username,COALESCE(avatar_id,'') AS avatar_id FROM users WHERE id=?", u)
	if row == nil {
		return api.ProfileUser{}, problem(404, "账号不存在")
	}
	user := api.ProfileUser{
		ID:          u,
		Phone:       maskPhone(str(row["phone"])),
		DisplayName: str(row["display_name"]),
		Username:    str(row["username"]),
		Created:     num(row["created"]),
	}
	if avatar := str(row["avatar_id"]); avatar != "" {
		user.AvatarURL = a.avatarURL(avatar)
	}
	return user, nil
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,20}$`)

// profileUpdate changes the display name and username. Usernames are unique
// and stored lowercase, so "Alice" and "alice" cannot be two people.
func (a *App) profileUpdate(w http.ResponseWriter, r *http.Request, u string) error {
	b, e := read[api.ProfileUpdate](r)
	if e != nil {
		return e
	}
	var name, username *string
	if b.DisplayName != nil {
		v := strings.TrimSpace(*b.DisplayName)
		if utf8.RuneCountInString(v) > 40 {
			return problem(400, "昵称最多 40 个字")
		}
		name = &v
	}
	if b.Username != nil {
		v := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(*b.Username), "@"))
		existing, err := a.profileUser(a.Store.DB, u)
		if err != nil {
			return err
		}
		if v != "" && !usernamePattern.MatchString(v) {
			return problem(400, "用户名为 3–20 位小写字母、数字或下划线")
		}
		if v != existing.Username {
			username = &v
		}
	}
	var user api.ProfileUser
	e = a.Store.Tx(userKey(u), func(tx *sql.Tx) error {
		if username != nil {
			if *username != "" && one(tx, "SELECT id FROM users WHERE username=? AND id<>?", *username, u) != nil {
				return problem(409, "这个用户名已被使用")
			}
			if err := a.profileUsernameSave(r, *username); err != nil {
				return err
			}
		}
		if name != nil {
			exec(tx, "UPDATE users SET display_name=? WHERE id=?", *name, u)
		}
		if username != nil {
			if *username == "" {
				exec(tx, "UPDATE users SET username=NULL WHERE id=?", u)
			} else {
				if one(tx, "SELECT id FROM users WHERE username=? AND id<>?", *username, u) != nil {
					return problem(409, "这个用户名已被使用")
				}
				exec(tx, "UPDATE users SET username=? WHERE id=?", *username, u)
			}
		}
		var e error
		user, e = a.profileUser(tx, u)
		return e
	})
	if e != nil {
		return e
	}
	respond(w, 200, user)
	return nil
}

// Reserve the login name with the authentication authority before changing its
// account-service mirror. A rejected edit never saves the name or display name.
func (a *App) profileUsernameSave(r *http.Request, username string) error {
	var value *string
	if username != "" {
		value = &username
	}
	body, _ := json.Marshal(struct {
		Username *string `json:"username"`
	}{value})
	req, err := http.NewRequestWithContext(r.Context(), "POST", a.Config.CommunityAuthURL+"/v1/community/profile/username", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	req.Header.Set("Content-Type", "application/json")
	response, err := communityHTTP.Do(req)
	if err != nil {
		return problemBoth(503, "用户名暂时无法保存，请稍后重试", "Your username could not be saved. Please try again shortly.")
	}
	defer response.Body.Close()
	if response.StatusCode == 200 {
		var result struct {
			Success bool `json:"success"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&result) == nil && result.Success {
			return nil
		}
		return problemBoth(503, "用户名暂时无法保存，请稍后重试", "Your username could not be saved. Please try again shortly.")
	}
	var failure struct {
		Error string `json:"error"`
	}
	supportedError := response.StatusCode == 400 || response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 409 || response.StatusCode == 429
	if supportedError && json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&failure) == nil && failure.Error != "" {
		return problem(response.StatusCode, failure.Error)
	}
	return problemBoth(503, "用户名暂时无法保存，请稍后重试", "Your username could not be saved. Please try again shortly.")
}

// avatarUpload replaces the avatar. The client has already cropped it to a
// square; the previous file is removed once the new one is in place.
func (a *App) avatarUpload(w http.ResponseWriter, r *http.Request, u string) error {
	b, e := read[api.AvatarUpload](r)
	if e != nil {
		return e
	}
	data, e := base64.StdEncoding.DecodeString(b.Data)
	if e != nil || len(data) == 0 || len(data) > 700*1024 {
		return problem(400, "头像为空、过大或格式不正确")
	}
	mime := http.DetectContentType(data)
	if mime != "image/jpeg" && mime != "image/png" && mime != "image/webp" {
		return problem(400, "头像支持 JPEG、PNG 和 WebP 图片")
	}
	if !a.rate("avatars:"+u, 30, 24*time.Hour) {
		return problem(429, "今日更换头像次数已达上限")
	}
	avatarID := id()
	path, e := a.Store.ImageWrite(avatarID, mime, data)
	if e != nil {
		return e
	}
	var user api.ProfileUser
	var previous string
	e = a.Store.Tx(userKey(u), func(tx *sql.Tx) error {
		previous = str(one(tx, "SELECT COALESCE(avatar_path,'') AS p FROM users WHERE id=?", u)["p"])
		exec(tx, "UPDATE users SET avatar_id=?,avatar_path=?,avatar_mime=? WHERE id=?", avatarID, path, mime, u)
		var e error
		user, e = a.profileUser(tx, u)
		return e
	})
	if e != nil {
		return e
	}
	if previous != "" {
		_ = a.Store.Blobs.Delete(previous)
	}
	respond(w, 200, user)
	return nil
}
