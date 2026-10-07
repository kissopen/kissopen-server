package app

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"kissopen.local/accounts/internal/api"
)

const themeSchema = `
CREATE TABLE IF NOT EXISTS themes(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,doc TEXT NOT NULL,public BOOLEAN NOT NULL DEFAULT FALSE,featured BOOLEAN NOT NULL DEFAULT FALSE,hidden BOOLEAN NOT NULL DEFAULT FALSE,created BIGINT NOT NULL,updated BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS themes_owner ON themes(owner_id,updated);
CREATE INDEX IF NOT EXISTS themes_gallery ON themes(public,hidden,updated);
CREATE TABLE IF NOT EXISTS theme_images(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,created BIGINT NOT NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_id TEXT;
`

const (
	themeSourceSystem = "system"
	themeSourceAI     = "ai"
	themeSourceUser   = "user"
	themeVersion      = 1
	// A theme's background picture, at most.
	themeImageMax = 3 * 1024 * 1024
)

var (
	themeFonts  = map[string]bool{"sans": true, "serif": true, "mono": true}
	themeRadii  = map[string]bool{"sharp": true, "soft": true, "round": true}
	themeColour = regexp.MustCompile(`^#[0-9a-f]{6}$`)
	themeShort  = regexp.MustCompile(`^#[0-9a-f]{3}$`)
	// Only an id this server made: lowercase hex, as id() writes it.
	themeImageID = regexp.MustCompile(`^[0-9a-f]{16,64}$`)
)

// themeSeeds are the product's own themes, in the order the page lists them.
// They are written once; the console may change them afterwards.
var themeSeeds = []api.Theme{
	{ID: "sys-kissopen", Name: "KissOpen", Description: "产品本来的样子：淡紫色的强调，安静的灰白。", Doc: api.ThemeDoc{Version: 1, Font: "sans", Radius: "soft",
		Light: api.ThemePalette{Accent: "#6b5bd2", OnAccent: "#ffffff", Canvas: "#f5f5f5", Surface: "#ffffff", Raised: "#f8f8f8", Text: "#000000", Muted: "#49454f", Line: "#eaeaea", Success: "#34c759", Warning: "#ff9500", Danger: "#ff3b30"},
		Dark:  api.ThemePalette{Accent: "#a597f3", OnAccent: "#16122b", Canvas: "#1e1e1e", Surface: "#212121", Raised: "#171717", Text: "#ffffff", Muted: "#cac4d0", Line: "#292929", Success: "#32d74b", Warning: "#ff9f0a", Danger: "#ff453a"}}},
	{ID: "sys-warm", Name: "暖阳", Description: "米色的纸、橙色的光，像午后的书桌。", Doc: api.ThemeDoc{Version: 1, Font: "sans", Radius: "soft",
		Light: api.ThemePalette{Accent: "#c96a1f", OnAccent: "#ffffff", Canvas: "#faf5ec", Surface: "#fffdf8", Raised: "#f3ecdf", Text: "#2b2118", Muted: "#6d6157", Line: "#e9dfcf", Success: "#3d9a5b", Warning: "#d98a11", Danger: "#d64533"},
		Dark:  api.ThemePalette{Accent: "#f0a35c", OnAccent: "#2a1a08", Canvas: "#211b16", Surface: "#2a231d", Raised: "#1a1511", Text: "#f6efe6", Muted: "#c7bbae", Line: "#3a3129", Success: "#6ccc8a", Warning: "#f2b451", Danger: "#f0766a"}}},
	{ID: "sys-teal", Name: "青川", Description: "青绿的水色，清爽而不刺眼。", Doc: api.ThemeDoc{Version: 1, Font: "sans", Radius: "soft",
		Light: api.ThemePalette{Accent: "#1a8a85", OnAccent: "#ffffff", Canvas: "#f1f7f7", Surface: "#ffffff", Raised: "#e8f1f1", Text: "#0f1f1e", Muted: "#4d6361", Line: "#d7e4e3", Success: "#2f9e5c", Warning: "#d68a0c", Danger: "#d94c3f"},
		Dark:  api.ThemePalette{Accent: "#5cc9c2", OnAccent: "#062120", Canvas: "#131c1c", Surface: "#1b2626", Raised: "#0f1717", Text: "#e8f2f1", Muted: "#a6bcba", Line: "#293736", Success: "#62cf8b", Warning: "#f0b24d", Danger: "#f07b70"}}},
	{ID: "sys-ink", Name: "墨", Description: "黑白高对比，只有文字和线条。", Doc: api.ThemeDoc{Version: 1, Font: "sans", Radius: "sharp",
		Light: api.ThemePalette{Accent: "#111111", OnAccent: "#ffffff", Canvas: "#ffffff", Surface: "#fafafa", Raised: "#f0f0f0", Text: "#000000", Muted: "#555555", Line: "#dcdcdc", Success: "#1f7a3e", Warning: "#a56600", Danger: "#c1272d"},
		Dark:  api.ThemePalette{Accent: "#f2f2f2", OnAccent: "#111111", Canvas: "#000000", Surface: "#111111", Raised: "#0a0a0a", Text: "#ffffff", Muted: "#bbbbbb", Line: "#333333", Success: "#5fd38a", Warning: "#f2c14e", Danger: "#ff6b66"}}},
	{ID: "sys-paper", Name: "护眼", Description: "微黄的纸色和柔和的绿，久看不累。", Doc: api.ThemeDoc{Version: 1, Font: "sans", Radius: "round",
		Light: api.ThemePalette{Accent: "#3d8756", OnAccent: "#ffffff", Canvas: "#f3f1e6", Surface: "#faf8ef", Raised: "#ebe8da", Text: "#22301f", Muted: "#5c6957", Line: "#dbd7c5", Success: "#3d8756", Warning: "#c98a12", Danger: "#c9483b"},
		Dark:  api.ThemePalette{Accent: "#7fc79a", OnAccent: "#0f2416", Canvas: "#1b1f1a", Surface: "#232a23", Raised: "#151a15", Text: "#e9eede", Muted: "#a8b3a1", Line: "#323b31", Success: "#7fc79a", Warning: "#e9b657", Danger: "#ef8177"}}},
	{ID: "sys-sakura", Name: "樱", Description: "粉色的强调，配很淡的暖白。", Doc: api.ThemeDoc{Version: 1, Font: "sans", Radius: "round",
		Light: api.ThemePalette{Accent: "#d0446f", OnAccent: "#ffffff", Canvas: "#fdf5f8", Surface: "#ffffff", Raised: "#f8ecf1", Text: "#2a1a22", Muted: "#6f5a64", Line: "#efdde5", Success: "#3a9a62", Warning: "#d98a11", Danger: "#d0446f"},
		Dark:  api.ThemePalette{Accent: "#f08bb0", OnAccent: "#2b0f1a", Canvas: "#1f171b", Surface: "#292024", Raised: "#171114", Text: "#f7eef2", Muted: "#c9b8c1", Line: "#3a2e34", Success: "#6fcf95", Warning: "#f2b451", Danger: "#f08bb0"}}},
}

// themesSeed writes the product's own themes where they are missing.
func (a *App) themesSeed() {
	at := now()
	for i, t := range themeSeeds {

		exec(a.Store.DB, `INSERT INTO themes(id,owner_id,name,description,source,doc,public,featured,hidden,created,updated)
            VALUES(?,?,?,?,?,?,TRUE,FALSE,FALSE,?,?) ON CONFLICT(id) DO NOTHING`,
			t.ID, "", t.Name, t.Description, themeSourceSystem, js(t.Doc), at+int64(i), at+int64(i))
	}
}

type rgb struct{ r, g, b float64 }

func parseColour(s string) (rgb, bool) {
	if !themeColour.MatchString(s) {
		return rgb{}, false
	}
	v, e := strconv.ParseUint(s[1:], 16, 32)
	if e != nil {
		return rgb{}, false
	}
	return rgb{float64(v>>16&255) / 255, float64(v>>8&255) / 255, float64(v&255) / 255}, true
}

func (c rgb) hex() string {
	b := func(v float64) int { return int(math.Round(math.Min(1, math.Max(0, v)) * 255)) }
	return fmt.Sprintf("#%02x%02x%02x", b(c.r), b(c.g), b(c.b))
}

// luminance is the WCAG relative luminance.
func (c rgb) luminance() float64 {
	lin := func(v float64) float64 {
		if v <= 0.03928 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(c.r) + 0.7152*lin(c.g) + 0.0722*lin(c.b)
}

// contrast is the WCAG contrast ratio between two colours, 1–21.
func contrast(a, b rgb) float64 {
	la, lb := a.luminance(), b.luminance()
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// mix is a blended t of the way from x to y.
func mix(x, y rgb, t float64) rgb {
	return rgb{x.r + (y.r-x.r)*t, x.g + (y.g-x.g)*t, x.b + (y.b-x.b)*t}
}

// normaliseColour writes a colour as lowercase "#rrggbb", expanding "#rgb".
func normaliseColour(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if themeShort.MatchString(s) {
		s = "#" + string(s[1]) + string(s[1]) + string(s[2]) + string(s[2]) + string(s[3]) + string(s[3])
	}
	return s
}

// The contrast each pair of a palette must reach.
const (
	themeTextContrast  = 4.5
	themeMutedContrast = 3
	themeOnAccentMin   = 3
)

func paletteColours(p *api.ThemePalette) []*string {
	return []*string{&p.Accent, &p.OnAccent, &p.Canvas, &p.Surface, &p.Raised, &p.Text, &p.Muted, &p.Line, &p.Success, &p.Warning, &p.Danger}
}

// paletteCheck normalises a palette's colours and says what is wrong with it.
func paletteCheck(p *api.ThemePalette, which string) error {
	names := []string{"accent", "on_accent", "canvas", "surface", "raised", "text", "muted", "line", "success", "warning", "danger"}
	for i, c := range paletteColours(p) {
		*c = normaliseColour(*c)
		if !themeColour.MatchString(*c) {
			return problemBoth(400, which+" 的 "+names[i]+" 不是 #rrggbb 颜色", which+" "+names[i]+" is not a #rrggbb colour")
		}
	}
	col := func(s string) rgb { c, _ := parseColour(s); return c }
	if contrast(col(p.Text), col(p.Canvas)) < themeTextContrast || contrast(col(p.Text), col(p.Surface)) < themeTextContrast {
		return problemBoth(400, which+" 的文字和背景对比度不够（至少 4.5:1）", which+" text does not contrast enough with its background (4.5:1)")
	}
	if contrast(col(p.Muted), col(p.Surface)) < themeMutedContrast {
		return problemBoth(400, which+" 的次要文字和卡片对比度不够（至少 3:1）", which+" secondary text does not contrast enough with cards (3:1)")
	}
	if contrast(col(p.OnAccent), col(p.Accent)) < themeOnAccentMin {
		return problemBoth(400, which+" 的按钮文字和强调色对比度不够（至少 3:1）", which+" text on the accent does not contrast enough (3:1)")
	}
	return nil
}

// paletteRepair moves a palette's text colours until they read, for a palette
// a model wrote: text becomes black or white, whichever reads better on the
// canvas; secondary text is text softened towards the card; text on the
// accent is black or white too.
func paletteRepair(p *api.ThemePalette) {
	for _, c := range paletteColours(p) {
		*c = normaliseColour(*c)
		if !themeColour.MatchString(*c) {
			*c = "#808080"
		}
	}
	col := func(s string) rgb { c, _ := parseColour(s); return c }
	black, white := rgb{0, 0, 0}, rgb{1, 1, 1}
	best := func(on rgb) rgb {
		if contrast(black, on) >= contrast(white, on) {
			return black
		}
		return white
	}
	if contrast(col(p.Text), col(p.Canvas)) < themeTextContrast || contrast(col(p.Text), col(p.Surface)) < themeTextContrast {
		p.Text = best(col(p.Canvas)).hex()
	}
	if contrast(col(p.Muted), col(p.Surface)) < themeMutedContrast {
		p.Muted = mix(col(p.Text), col(p.Surface), 0.35).hex()
	}
	if contrast(col(p.OnAccent), col(p.Accent)) < themeOnAccentMin {
		p.OnAccent = best(col(p.Accent)).hex()
	}
}

// themeDocCheck normalises a document and says what is wrong with it. The
// background must be a picture this server keeps.
func (a *App) themeDocCheck(d *api.ThemeDoc) error {
	if d.Version == 0 {
		d.Version = themeVersion
	}
	if d.Version != themeVersion {
		return problemBoth(400, "不认识这个主题文件的版本", "Unknown theme file version")
	}
	d.Font = strings.ToLower(strings.TrimSpace(d.Font))
	if d.Font == "" {
		d.Font = "sans"
	}
	if !themeFonts[d.Font] {
		return problemBoth(400, "字体只能是 sans、serif 或 mono", "Font must be sans, serif or mono")
	}
	d.Radius = strings.ToLower(strings.TrimSpace(d.Radius))
	if d.Radius == "" {
		d.Radius = "soft"
	}
	if !themeRadii[d.Radius] {
		return problemBoth(400, "圆角只能是 sharp、soft 或 round", "Radius must be sharp, soft or round")
	}
	if e := paletteCheck(&d.Light, "浅色"); e != nil {
		return e
	}
	if e := paletteCheck(&d.Dark, "深色"); e != nil {
		return e
	}
	if d.Background != nil {
		if d.Background.URL == "" {
			d.Background = nil
		} else {
			id, ok := a.themeImageIDOf(d.Background.URL)
			if !ok || one(a.Store.DB, "SELECT id FROM theme_images WHERE id=?", id) == nil {
				return problemBoth(400, "背景图片必须先上传到 KissOpen", "The background must be a picture uploaded to KissOpen")
			}
			d.Background.URL = a.themeImageURL(id)
			if d.Background.Opacity == 0 {
				d.Background.Opacity = 0.3
			}
			d.Background.Opacity = math.Min(1, math.Max(0.05, d.Background.Opacity))
			d.Background.Blur = max(0, min(40, d.Background.Blur))
		}
	}
	return nil
}

func (a *App) themeImageURL(id string) string { return a.Config.PublicURL + "/api/themes/images/" + id }

// themeImageIDOf reads the id out of a background URL this server issued.
func (a *App) themeImageIDOf(u string) (string, bool) {
	prefix := a.Config.PublicURL + "/api/themes/images/"
	if !strings.HasPrefix(u, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(u, prefix)
	return id, themeImageID.MatchString(id)
}

// flag reads a boolean column however the driver hands it over.
func flag(v any) bool {
	switch b := v.(type) {
	case bool:
		return b
	case int64:
		return b != 0
	case string:
		return b == "t" || b == "true" || b == "1"
	}
	return false
}

const themeColumns = `t.id,t.owner_id,t.name,t.description,t.source,t.doc,t.public,t.featured,t.hidden,t.created,t.updated,
    COALESCE(o.display_name,'') AS owner_name,COALESCE(o.phone,'') AS owner_phone,
    (SELECT COUNT(*) FROM users x WHERE x.theme_id=t.id) AS uses`

const themeFrom = ` FROM themes t LEFT JOIN users o ON o.id=t.owner_id `

// themeOf turns a row into a theme as user u sees it.
func themeOf(row M, u string) api.Theme {
	var doc api.ThemeDoc
	_ = json.Unmarshal([]byte(str(row["doc"])), &doc)
	t := api.Theme{
		ID: str(row["id"]), Name: str(row["name"]), Description: str(row["description"]), Source: str(row["source"]),
		Mine: str(row["owner_id"]) != "" && str(row["owner_id"]) == u, Public: flag(row["public"]), Featured: flag(row["featured"]),
		Uses: int(num(row["uses"])), Created: num(row["created"]), Updated: num(row["updated"]), Doc: doc,
	}
	if str(row["owner_id"]) != "" {
		t.Owner = ownerName(str(row["owner_name"]), str(row["owner_phone"]))
	}
	return t
}

func themesOf(rows []M, u string) []api.Theme {
	out := make([]api.Theme, 0, len(rows))
	for _, r := range rows {
		out = append(out, themeOf(r, u))
	}
	return out
}

// themeVisible reads one theme if user u may see it: the product's own, one
// in the gallery, or the user's.
func (a *App) themeVisible(q querier, id, u string) (M, error) {
	row := one(q, "SELECT "+themeColumns+themeFrom+"WHERE t.id=?", id)
	if row == nil {
		return nil, problemBoth(404, "主题不存在", "No such theme")
	}
	owner := str(row["owner_id"])
	if owner == u && u != "" {
		return row, nil
	}
	if str(row["source"]) == themeSourceSystem || (flag(row["public"]) && !flag(row["hidden"])) {
		return row, nil
	}
	return nil, problemBoth(404, "主题不存在", "No such theme")
}

// userTheme is the theme an account chose, or nil for the product's own look.
// A theme its owner deleted or the console hid is no longer a choice.
func (a *App) userTheme(q querier, u string) *api.Theme {
	id := str(one(q, "SELECT COALESCE(theme_id,'') AS theme_id FROM users WHERE id=?", u)["theme_id"])
	if id == "" {
		return nil
	}
	row, e := a.themeVisible(q, id, u)
	if e != nil {
		return nil
	}
	t := themeOf(row, u)
	return &t
}

func (a *App) themeRoutes() {
	a.route("GET /api/themes", true, a.themesPage)
	a.route("GET /api/themes/gallery", true, a.themesGallery)

	a.route("POST /api/themes/gallery", true, a.themesGallery)
	a.route("POST /api/themes/{id}", true, a.themeUpdate)
	a.route("POST /api/themes/{id}/delete", true, a.themeDelete)
	a.route("GET /api/themes/public/{id}", false, func(w http.ResponseWriter, r *http.Request, _ string) error {
		row, e := a.themeVisible(a.Store.DB, r.PathValue("id"), "")
		if e != nil {
			return e
		}
		respond(w, 200, themeOf(row, ""))
		return nil
	})
	a.route("GET /api/themes/images/{id}", false, a.themeImage)
	a.route("GET /api/themes/{id}", true, func(w http.ResponseWriter, r *http.Request, u string) error {
		row, e := a.themeVisible(a.Store.DB, r.PathValue("id"), u)
		if e != nil {
			return e
		}
		respond(w, 200, themeOf(row, u))
		return nil
	})
	a.route("POST /api/themes", true, a.themeCreate)
	a.route("PUT /api/themes/{id}", true, a.themeUpdate)
	a.route("DELETE /api/themes/{id}", true, a.themeDelete)
	a.route("POST /api/themes/{id}/publish", true, func(w http.ResponseWriter, r *http.Request, u string) error {
		return a.themePublish(w, r, u, true)
	})
	a.route("POST /api/themes/{id}/unpublish", true, func(w http.ResponseWriter, r *http.Request, u string) error {
		return a.themePublish(w, r, u, false)
	})
	a.route("POST /api/themes/select", true, a.themeSelect)
	a.route("POST /api/themes/images", true, a.themeImageUpload)
}

func (a *App) themesPage(w http.ResponseWriter, r *http.Request, u string) error {
	db := a.Store.DB
	page := api.ThemesPage{
		Selected: str(one(db, "SELECT COALESCE(theme_id,'') AS theme_id FROM users WHERE id=?", u)["theme_id"]),
		System:   themesOf(all(db, "SELECT "+themeColumns+themeFrom+"WHERE t.source='system' AND NOT t.hidden ORDER BY t.created,t.id"), u),
		Mine:     themesOf(all(db, "SELECT "+themeColumns+themeFrom+"WHERE t.owner_id=? ORDER BY t.updated DESC", u), u),
		Featured: themesOf(all(db, "SELECT "+themeColumns+themeFrom+"WHERE t.featured AND t.public AND NOT t.hidden AND t.source<>'system' ORDER BY t.updated DESC LIMIT 12"), u),

		CanGenerate: false, // Generated by the local Agent, never by this service.
	}
	if page.Selected != "" && a.userTheme(db, u) == nil {
		page.Selected = ""
	}
	respond(w, 200, page)
	return nil
}

func (a *App) themesGallery(w http.ResponseWriter, r *http.Request, u string) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	sort := r.URL.Query().Get("sort")
	limit := queryInt(r, "limit", 24, 60)
	offset := queryInt(r, "offset", 0, 100000)
	if r.Method == "POST" {
		in, e := read[api.ThemeGalleryRequest](r)
		if e != nil {
			return e
		}
		q, sort = strings.TrimSpace(in.Q), in.Sort
		if in.Limit > 0 {
			limit = min(int64(in.Limit), 60)
		}
		if in.Offset > 0 {
			offset = int64(in.Offset)
		}
	}
	where := "WHERE t.public AND NOT t.hidden AND t.source<>'system'"
	args := []any{}
	if q != "" {
		where += " AND (t.name ILIKE ? OR t.description ILIKE ?)"
		args = append(args, "%"+q+"%", "%"+q+"%")
	}
	order := " ORDER BY t.featured DESC, uses DESC, t.updated DESC"
	if sort == "new" {
		order = " ORDER BY t.updated DESC"
	}
	total := int(num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM themes t "+where, args...)["n"]))
	rows := all(a.Store.DB, "SELECT "+themeColumns+themeFrom+where+order+" LIMIT ? OFFSET ?", append(args, limit, offset)...)
	respond(w, 200, api.ThemeGallery{Themes: themesOf(rows, u), Total: total})
	return nil
}

// themeWriteCheck reads and checks what a theme is made or changed with.
func (a *App) themeWriteCheck(r *http.Request) (api.ThemeWrite, error) {
	in, e := read[api.ThemeWrite](r)
	if e != nil {
		return in, e
	}
	in.Name = clip(strings.TrimSpace(in.Name), 40)
	if in.Name == "" {
		return in, problemBoth(400, "给主题起个名字", "Give the theme a name")
	}
	in.Description = clip(strings.TrimSpace(in.Description), 200)
	if in.Source != themeSourceAI {
		in.Source = themeSourceUser
	}
	if e := a.themeDocCheck(&in.Doc); e != nil {
		return in, e
	}
	return in, nil
}

func (a *App) themeCreate(w http.ResponseWriter, r *http.Request, u string) error {
	in, e := a.themeWriteCheck(r)
	if e != nil {
		return e
	}
	if num(one(a.Store.DB, "SELECT COUNT(*) AS n FROM themes WHERE owner_id=?", u)["n"]) >= 50 {
		return problemBoth(400, "最多保存 50 个主题，删掉一些再试", "You can keep up to 50 themes; delete some first")
	}
	id := id()
	exec(a.Store.DB, `INSERT INTO themes(id,owner_id,name,description,source,doc,public,featured,hidden,created,updated) VALUES(?,?,?,?,?,?,FALSE,FALSE,FALSE,?,?)`,
		id, u, in.Name, in.Description, in.Source, js(in.Doc), now(), now())
	row, _ := a.themeVisible(a.Store.DB, id, u)
	respond(w, 200, themeOf(row, u))
	return nil
}

// themeOwned reads a theme of the user's own, or says there is none.
func (a *App) themeOwned(q querier, id, u string) (M, error) {
	row := one(q, "SELECT "+themeColumns+themeFrom+"WHERE t.id=? AND t.owner_id=? AND t.owner_id<>''", id, u)
	if row == nil {
		return nil, problemBoth(404, "主题不存在，或不是你的", "No such theme of yours")
	}
	return row, nil
}

func (a *App) themeUpdate(w http.ResponseWriter, r *http.Request, u string) error {
	id := r.PathValue("id")
	if _, e := a.themeOwned(a.Store.DB, id, u); e != nil {
		return e
	}
	in, e := a.themeWriteCheck(r)
	if e != nil {
		return e
	}
	exec(a.Store.DB, "UPDATE themes SET name=?,description=?,doc=?,updated=? WHERE id=?", in.Name, in.Description, js(in.Doc), now(), id)
	row, _ := a.themeVisible(a.Store.DB, id, u)
	respond(w, 200, themeOf(row, u))
	return nil
}

func (a *App) themeDelete(w http.ResponseWriter, r *http.Request, u string) error {
	id := r.PathValue("id")
	if _, e := a.themeOwned(a.Store.DB, id, u); e != nil {
		return e
	}
	a.themeRemove(id)
	respond(w, 200, api.Ok{Ok: true})
	return nil
}

// themeRemove deletes a theme; accounts using it go back to the product's own look.
func (a *App) themeRemove(id string) {
	exec(a.Store.DB, "UPDATE users SET theme_id=NULL WHERE theme_id=?", id)
	exec(a.Store.DB, "DELETE FROM themes WHERE id=?", id)
}

func (a *App) themePublish(w http.ResponseWriter, r *http.Request, u string, public bool) error {
	id := r.PathValue("id")
	if _, e := a.themeOwned(a.Store.DB, id, u); e != nil {
		return e
	}
	exec(a.Store.DB, "UPDATE themes SET public=?,updated=? WHERE id=?", public, now(), id)
	row, _ := a.themeVisible(a.Store.DB, id, u)
	respond(w, 200, themeOf(row, u))
	return nil
}

func (a *App) themeSelect(w http.ResponseWriter, r *http.Request, u string) error {
	in, e := read[api.ThemeSelect](r)
	if e != nil {
		return e
	}
	in.ID = strings.TrimSpace(in.ID)
	if in.ID == "" {
		exec(a.Store.DB, "UPDATE users SET theme_id=NULL WHERE id=?", u)
		respond(w, 200, api.ThemeSelected{})
		return nil
	}
	row, e := a.themeVisible(a.Store.DB, in.ID, u)
	if e != nil {
		return e
	}
	exec(a.Store.DB, "UPDATE users SET theme_id=? WHERE id=?", in.ID, u)
	t := themeOf(row, u)
	t.Uses++
	respond(w, 200, api.ThemeSelected{Theme: &t})
	return nil
}

func (a *App) themeImageUpload(w http.ResponseWriter, r *http.Request, u string) error {
	b, e := read[api.ThemeImageUpload](r)
	if e != nil {
		return e
	}
	data, e := base64.StdEncoding.DecodeString(b.Data)
	if e != nil || len(data) == 0 {
		return problemBoth(400, "这张背景图片无法读取，请重新选择 JPEG、PNG 或 WebP 图片", "This background picture could not be read. Choose a JPEG, PNG or WebP picture again.")
	}
	if len(data) > themeImageMax {
		return problemBoth(413, "背景图片不能超过 3 MB，请压缩图片或换一张后重试", "Choose a background picture up to 3 MB. Compress it or choose a smaller one, then try again.")
	}
	mime := http.DetectContentType(data)
	if mime != "image/jpeg" && mime != "image/png" && mime != "image/webp" {
		return problemBoth(400, "背景只支持 JPEG、PNG 和 WebP，请转换图片格式后重试", "Use a JPEG, PNG or WebP background. Convert the picture's format, then try again.")
	}
	if !a.rate("theme-images:"+u, 20, 24*time.Hour) {
		return problemBoth(429, "今天上传的背景图片已达上限", "Today's limit on background pictures is reached")
	}
	imageID := id()
	path, e := a.Store.ImageWrite(imageID, mime, data)
	if e != nil {
		return e
	}
	exec(a.Store.DB, "INSERT INTO theme_images(id,owner_id,path,mime,created) VALUES(?,?,?,?,?)", imageID, u, path, mime, now())
	respond(w, 200, api.ThemeImage{URL: a.themeImageURL(imageID)})
	return nil
}

// themeImage serves a background picture. Its id is the only key: a theme that
// carries it may be in anyone's gallery, and the id cannot be guessed.
func (a *App) themeImage(w http.ResponseWriter, r *http.Request, _ string) error {
	row := one(a.Store.DB, "SELECT path,mime,created FROM theme_images WHERE id=?", r.PathValue("id"))
	if row == nil {
		return problem(404, "内容不存在")
	}
	return a.serveStored(w, r, str(row["path"]), str(row["mime"]), num(row["created"]), now()+30*dayMillis)
}
