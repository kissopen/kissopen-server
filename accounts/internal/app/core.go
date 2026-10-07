package app

import (
	"database/sql"
	"net/http"
	"time"

	"kissopen.local/accounts/internal/api"
)

// App deliberately has no model gateway, cloud runtime or background worker.
type App struct {
	Config Config
	Store  *Store
	mux    *http.ServeMux
}

func New(c Config) (*App, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	blobs, err := blobsFor(c)
	if err != nil {
		return nil, err
	}
	store, err := OpenStore(c.Database, blobs)
	if err != nil {
		return nil, err
	}
	a := &App{Config: c, Store: store, mux: http.NewServeMux()}
	// Startup seed errors must fail startup, rather than leak a database handle.
	if err := func() (err error) {
		defer func() {
			if recover() != nil {
				err = problemBoth(500, "主题初始化失败", "Theme initialisation failed")
			}
		}()
		a.themesSeed()
		return nil
	}(); err != nil {
		store.DB.Close()
		return nil, err
	}
	a.routes()
	return a, nil
}

func (a *App) routes() {
	a.securityRoutes()
	a.adminRoutes()
	a.themeRoutes()
	a.workspaceRoutes() // explicit upgrade errors; relay owns account workspace keys
	a.route("GET /api/config", false, func(w http.ResponseWriter, r *http.Request, _ string) error {
		respond(w, 200, api.Config{Name: "kissopen", NameZh: "KissOpen", Development: a.Config.Dev()})
		return nil
	})
	a.route("GET /healthz", false, func(w http.ResponseWriter, r *http.Request, _ string) error {
		if err := a.Store.DB.PingContext(r.Context()); err != nil {
			return err
		}
		respond(w, 200, api.Ok{Ok: true})
		return nil
	})
	a.route("GET /api/me", true, func(w http.ResponseWriter, r *http.Request, u string) error {
		user, err := a.profileUser(a.Store.DB, u)
		if err != nil {
			return err
		}
		respond(w, 200, api.User{ID: u, Phone: user.Phone, DisplayName: user.DisplayName, AvatarURL: user.AvatarURL, Persona: a.persona(a.Store.DB, u), Theme: a.userTheme(a.Store.DB, u)})
		return nil
	})
	a.route("POST /api/auth/logout", true, func(w http.ResponseWriter, r *http.Request, _ string) error {
		exec(a.Store.DB, "UPDATE community_sessions SET revoked=TRUE WHERE hash=?", signature(a.Config.Secret, a.token(r)))
		http.SetCookie(w, &http.Cookie{Name: "kissopen_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: !a.Config.Dev(), SameSite: http.SameSiteLaxMode})
		respond(w, 200, api.Ok{Ok: true})
		return nil
	})
	a.route("GET /api/profile", true, func(w http.ResponseWriter, r *http.Request, u string) error {
		user, err := a.profileUser(a.Store.DB, u)
		if err != nil {
			return err
		}
		// Local model usage belongs to the local Agent. Never fabricate server stats.
		respond(w, 200, api.Profile{User: user, Models: []api.ModelUse{}, Activity: []api.ActivityDay{}})
		return nil
	})
	a.route("POST /api/profile", true, a.profileUpdate)
	a.route("POST /api/profile/avatar", true, a.avatarUpload)
	a.route("GET /api/avatars/{id}", false, a.avatar)
	a.route("POST /api/persona", true, a.personaUpdate)
	// Preserve existing client URLs only for read-only plugin distribution.
	// Installation/enabling/credentials stay on the local Agent.
	a.route("GET /api/cloud/catalog", true, a.cloudCatalog)
	a.route("GET /api/cloud/catalog/{id}", true, a.cloudCatalogDetail)
	a.route("GET /api/cloud/catalog/{id}/package", true, a.cloudCatalogPackage)
	a.route("POST /api/themes/generate", true, func(w http.ResponseWriter, r *http.Request, _ string) error {
		return problemBoth(410, "请使用本地 Agent 制作主题", "Create themes with your local Agent")
	})
	a.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, r, problemBoth(404, "接口不存在", "Not found"))
	})
}

func OpenStore(dsn string, blobs Blobs) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err = db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if err = schemaApply(db, accountSchema, themeSchema, adminSchema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{DB: db, Blobs: blobs}, nil
}

// Additive, compatible with existing account/theme records. No DROP statements;
// old commercial tables are neither read nor migrated by this service.
const accountSchema = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,phone TEXT UNIQUE,created BIGINT NOT NULL);
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS persona_json TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_avatar ON users(avatar_id);
CREATE TABLE IF NOT EXISTS community_users(identity_id TEXT PRIMARY KEY,provider TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE REFERENCES users(id));
CREATE TABLE IF NOT EXISTS community_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),revoked BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count BIGINT NOT NULL,reset BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),secret TEXT NOT NULL,created BIGINT NOT NULL);
`
