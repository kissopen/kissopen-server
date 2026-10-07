package app

import (
	"database/sql"
	"net/http"
	"strings"
)

// Only explicitly authorised stable identities or existing admins gain access.
func (a *App) isAdmin(user string) bool {
	if user == "" {
		return false
	}
	if one(a.Store.DB, "SELECT user_id FROM admins WHERE user_id=?", user) != nil {
		return true
	}
	identity := str(one(a.Store.DB, "SELECT identity_id FROM community_users WHERE user_id=?", user)["identity_id"])
	for _, allowed := range a.Config.AdminIdentities {
		if identity != "" && identity == allowed {
			return true
		}
	}
	return false
}
func (a *App) adminRoute(pattern string, h handler) {
	a.route(pattern, true, func(w http.ResponseWriter, r *http.Request, u string) error {
		if !a.isAdmin(u) {
			return problemBoth(403, "没有后台权限", "Administrator access is required")
		}
		return h(w, r, u)
	})
}
func audited(q querier, user, action, target string, detail any) {
	exec(q, "INSERT INTO audit(id,at,user_id,action,target,detail) VALUES(?,?,?,?,?,?)", id(), now(), user, action, target, js(detail))
}
func (a *App) adminRoutes() {
	a.adminThemeRoutes()
	a.adminRoute("GET /api/admin/me", func(w http.ResponseWriter, r *http.Request, u string) error {
		respond(w, 200, M{"id": u, "admin": true})
		return nil
	})
	a.adminRoute("GET /api/admin/users", func(w http.ResponseWriter, r *http.Request, _ string) error {
		limit, offset := queryInt(r, "limit", 50, 200), queryInt(r, "offset", 0, 1000000)
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		where := "WHERE TRUE"
		args := []any{}
		if q != "" {
			where += " AND (u.display_name ILIKE ? OR u.username ILIKE ? OR c.identity_id=?)"
			args = append(args, "%"+q+"%", "%"+q+"%", q)
		}
		from := " FROM users u LEFT JOIN community_users c ON c.user_id=u.id "
		total := num(one(a.Store.DB, "SELECT COUNT(*) AS n"+from+where, args...)["n"])
		users := all(a.Store.DB, "SELECT u.id,u.display_name,u.username,u.created,u.disabled,c.identity_id,c.provider"+from+where+" ORDER BY u.created DESC,u.id LIMIT ? OFFSET ?", append(args, limit, offset)...)
		respond(w, 200, M{"users": users, "total": total})
		return nil
	})
	a.adminRoute("POST /api/admin/users/{id}/disable", func(w http.ResponseWriter, r *http.Request, u string) error {
		target := r.PathValue("id")
		in, err := read[struct {
			Disabled bool `json:"disabled"`
		}](r)
		if err != nil {
			return err
		}
		if target == u && in.Disabled {
			return problemBoth(400, "不能封禁自己", "You cannot disable your own account")
		}
		disabled := int64(0)
		if in.Disabled {
			disabled = now()
		}
		return a.Store.Tx(userKey(target), func(tx *sql.Tx) error {
			if exec(tx, "UPDATE users SET disabled=? WHERE id=?", disabled, target) != 1 {
				return problemBoth(404, "用户不存在", "Account not found")
			}
			if in.Disabled {
				exec(tx, "UPDATE community_sessions SET revoked=TRUE WHERE user_id=?", target)
			}
			audited(tx, u, "user.disable", target, M{"disabled": in.Disabled})
			respond(w, 200, M{"disabled": disabled})
			return nil
		})
	})
	a.adminRoute("POST /api/admin/users/{id}/logout", func(w http.ResponseWriter, r *http.Request, u string) error {
		target := r.PathValue("id")
		return a.Store.Tx(userKey(target), func(tx *sql.Tx) error {
			if one(tx, "SELECT id FROM users WHERE id=?", target) == nil {
				return problemBoth(404, "用户不存在", "Account not found")
			}
			n := exec(tx, "UPDATE community_sessions SET revoked=TRUE WHERE user_id=? AND revoked=FALSE", target)
			audited(tx, u, "user.logout", target, M{"sessions": n})
			respond(w, 200, M{"sessions": n})
			return nil
		})
	})
	a.adminRoute("GET /api/admin/audit", func(w http.ResponseWriter, r *http.Request, _ string) error {
		respond(w, 200, M{"entries": all(a.Store.DB, "SELECT * FROM audit ORDER BY at DESC,id LIMIT ?", queryInt(r, "limit", 100, 500))})
		return nil
	})
}

const adminSchema = `
CREATE TABLE IF NOT EXISTS admins(user_id TEXT PRIMARY KEY REFERENCES users(id),role TEXT NOT NULL DEFAULT 'owner',created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at BIGINT NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
`
