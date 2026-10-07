package app

import (
	"net/http"
	"strings"

	"kissopen.local/accounts/internal/api"
)

/*
The console's view of themes: everything anyone made, to feature, hide or
delete, and the product's own to edit or add to.
*/

func (a *App) adminThemeRoutes() {
	a.adminRoute("GET /api/admin/themes", a.adminThemes)
	a.adminRoute("POST /api/admin/themes", a.adminThemeCreate)
	a.adminRoute("PUT /api/admin/themes/{id}", a.adminThemeUpdate)
	a.adminRoute("POST /api/admin/themes/{id}/{action}", a.adminThemeAction)
}

// adminThemeOf is a theme with what the console also wants to know.
func adminThemeOf(row M) M {
	t := themeOf(row, "")
	return M{"theme": t, "owner_id": str(row["owner_id"]), "owner_phone": maskPhone(str(row["owner_phone"])), "hidden": flag(row["hidden"])}
}

func (a *App) adminThemes(w http.ResponseWriter, r *http.Request, _ string) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := queryInt(r, "limit", 50, 200)
	offset := queryInt(r, "offset", 0, 1000000)
	if r.URL.Query().Get("offset") == "0" {
		offset = 0
	}
	where := "WHERE TRUE"
	args := []any{}
	switch r.URL.Query().Get("filter") {
	case "system":
		where += " AND t.source='system'"
	case "public":
		where += " AND t.public AND NOT t.hidden AND t.source<>'system'"
	case "featured":
		where += " AND t.featured"
	case "hidden":
		where += " AND t.hidden"
	}
	if q != "" {
		where += " AND (t.name ILIKE ? OR t.description ILIKE ? OR o.phone LIKE ? OR o.display_name ILIKE ?)"
		args = append(args, "%"+q+"%", "%"+q+"%", "%"+q+"%", "%"+q+"%")
	}
	total := int(num(one(a.Store.DB, "SELECT COUNT(*) AS n"+themeFrom+where, args...)["n"]))
	rows := all(a.Store.DB, "SELECT "+themeColumns+themeFrom+where+" ORDER BY t.updated DESC LIMIT ? OFFSET ?", append(args, limit, offset)...)
	themes := make([]M, 0, len(rows))
	for _, row := range rows {
		themes = append(themes, adminThemeOf(row))
	}
	respond(w, 200, M{"themes": themes, "total": total,
		"counts": M{
			"all":      num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM themes")["n"]),
			"public":   num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM themes WHERE public AND NOT hidden AND source<>'system'")["n"]),
			"featured": num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM themes WHERE featured")["n"]),
			"hidden":   num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM themes WHERE hidden")["n"]),
			"in_use":   num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM users WHERE theme_id IS NOT NULL")["n"]),
		}})
	return nil
}

// adminThemeCreate adds one of the product's own themes.
func (a *App) adminThemeCreate(w http.ResponseWriter, r *http.Request, u string) error {
	in, e := a.themeWriteCheck(r)
	if e != nil {
		return e
	}
	id := "sys-" + id()[:12]
	exec(a.Store.DB, `INSERT INTO themes(id,owner_id,name,description,source,doc,public,featured,hidden,created,updated) VALUES(?,?,?,?,?,?,TRUE,FALSE,FALSE,?,?)`,
		id, "", in.Name, in.Description, themeSourceSystem, js(in.Doc), now(), now())
	audited(a.Store.DB, u, "theme.create", id, M{"name": in.Name})
	respond(w, 200, adminThemeOf(one(a.Store.DB, "SELECT "+themeColumns+themeFrom+"WHERE t.id=?", id)))
	return nil
}

// adminThemeUpdate changes any theme's name, description and colours.
func (a *App) adminThemeUpdate(w http.ResponseWriter, r *http.Request, u string) error {
	id := r.PathValue("id")
	if one(a.Store.DB, "SELECT id FROM themes WHERE id=?", id) == nil {
		return problemBoth(404, "主题不存在", "No such theme")
	}
	in, e := a.themeWriteCheck(r)
	if e != nil {
		return e
	}
	exec(a.Store.DB, "UPDATE themes SET name=?,description=?,doc=?,updated=? WHERE id=?", in.Name, in.Description, js(in.Doc), now(), id)
	audited(a.Store.DB, u, "theme.update", id, M{"name": in.Name})
	respond(w, 200, adminThemeOf(one(a.Store.DB, "SELECT "+themeColumns+themeFrom+"WHERE t.id=?", id)))
	return nil
}

func (a *App) adminThemeAction(w http.ResponseWriter, r *http.Request, u string) error {
	id, action := r.PathValue("id"), r.PathValue("action")
	row := one(a.Store.DB, "SELECT id,source FROM themes WHERE id=?", id)
	if row == nil {
		return problemBoth(404, "主题不存在", "No such theme")
	}
	switch action {
	case "feature":
		exec(a.Store.DB, "UPDATE themes SET featured=TRUE,updated=? WHERE id=?", now(), id)
	case "unfeature":
		exec(a.Store.DB, "UPDATE themes SET featured=FALSE,updated=? WHERE id=?", now(), id)
	case "hide":
		// Hidden is gone from the gallery and from everyone who chose it; the
		// owner keeps it.
		exec(a.Store.DB, "UPDATE themes SET hidden=TRUE,featured=FALSE,updated=? WHERE id=?", now(), id)
		exec(a.Store.DB, "UPDATE users SET theme_id=NULL WHERE theme_id=? AND id<>(SELECT owner_id FROM themes WHERE id=?)", id, id)
	case "unhide":
		exec(a.Store.DB, "UPDATE themes SET hidden=FALSE,updated=? WHERE id=?", now(), id)
	case "delete":
		a.themeRemove(id)
	default:
		return problemBoth(400, "未知的操作", "Unknown action")
	}
	audited(a.Store.DB, u, "theme."+action, id, nil)
	if action == "delete" {
		respond(w, 200, api.Ok{Ok: true})
		return nil
	}
	respond(w, 200, adminThemeOf(one(a.Store.DB, "SELECT "+themeColumns+themeFrom+"WHERE t.id=?", id)))
	return nil
}
