package app

import (
	"crypto/sha256"

	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"net/http"
	"os"
	"path/filepath"
	"regexp"

	"kissopen.local/accounts/internal/api"
)

const maxPackageBytes = 8 << 20

var pluginName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func validPluginName(id string) bool {
	return pluginName.MatchString(id) && id != "apply" && id != "credentials"
}

// Read-only catalog distribution. The legacy /cloud/catalog URL is preserved,
// but installing and executing packages belongs exclusively to the local Agent.
type catalogEntry struct {
	ID          string `json:"id"`
	Title       string `json:"title,omitempty"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Skills      int    `json:"skills"`
	Servers     int    `json:"servers"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	// Absolute by the time the phone sees it: the index records a path
	// relative to the published directory, and only this server knows what
	// that directory is served as.
	Icon string `json:"icon,omitempty"`
	// At least one of its MCP servers answers an authorization challenge, so
	// those tools will not work until the account is connected.
	NeedsConnection bool `json:"needs_connection,omitempty"`
	// And it has nothing else: no skills, so installing it before there is a
	// way to connect installs nothing that works.
	ConnectionOnly bool     `json:"connection_only,omitempty"`
	File           string   `json:"file"`
	Partial        []string `json:"partial,omitempty"`
}

// The published index, read from disk on each request. It changes when someone
// publishes, which is rare and never through this process, so there is nothing
// here worth the staleness a cache would buy.
func (a *App) catalogEntries() ([]catalogEntry, error) {
	if a.Config.PluginCatalog == "" {
		return nil, nil
	}
	body, err := os.ReadFile(filepath.Join(a.Config.PluginCatalog, "index.json"))
	if err != nil {
		return nil, err
	}
	var index struct {
		Plugins []catalogEntry `json:"plugins"`
	}
	if err = json.Unmarshal(body, &index); err != nil {
		return nil, err
	}
	return index.Plugins, nil
}

func (a *App) cloudCatalog(w http.ResponseWriter, r *http.Request, u string) error {
	entries, err := a.catalogEntries()
	if err != nil {
		return problemBoth(503, "插件目录暂不可用", "The plugin catalog is unavailable")
	}
	if entries == nil {
		entries = []catalogEntry{}
	}

	for i := range entries {
		if entries[i].Icon != "" {
			entries[i].Icon = a.Config.PublicURL + "/downloads/plugins/" + entries[i].Icon
		}
	}
	respond(w, 200, map[string]any{"plugins": entries})
	return nil
}

// Everything about one published package, for the page a reader decides on.
//
// Kept out of the listing because it is the part that does not scale with it:
// the skills alone run to five hundred entries across the catalog, and a list
// of rows has no use for any of them.
func (a *App) cloudCatalogDetail(w http.ResponseWriter, r *http.Request, u string) error {
	id := r.PathValue("id")
	if !validPluginName(id) || a.Config.PluginCatalog == "" {
		return problemBoth(404, "没有这个插件", "No such plugin")
	}
	body, err := os.ReadFile(filepath.Join(a.Config.PluginCatalog, "details", id+".json"))
	if err != nil {
		return problemBoth(404, "没有这个插件", "No such plugin")
	}
	var detail map[string]any
	if err = json.Unmarshal(body, &detail); err != nil {
		return problemBoth(500, "插件目录有误", "The plugin catalog is malformed")
	}

	if _, err = os.Stat(filepath.Join(a.Config.PluginCatalog, "icons", id+".png")); err == nil {
		detail["icon"] = a.Config.PublicURL + "/downloads/plugins/icons/" + id + ".png"
	}
	respond(w, 200, detail)
	return nil
}

// A desktop downloads the verified package, never provisioning a cloud Agent.
func (a *App) cloudCatalogPackage(w http.ResponseWriter, r *http.Request, u string) error {
	body, sum, err := a.catalogPackage(r.PathValue("id"))
	if err != nil {
		return err
	}
	respond(w, 200, api.CatalogPackage{ID: r.PathValue("id"), SHA256: sum, Archive: base64.StdEncoding.EncodeToString(body)})
	return nil
}

func (a *App) catalogPackage(id string) ([]byte, string, error) {
	if !validPluginName(id) {
		return nil, "", problem(400, "请求格式不正确")
	}
	entries, err := a.catalogEntries()
	if err != nil {
		return nil, "", problemBoth(503, "插件目录暂不可用", "The plugin catalog is unavailable")
	}
	var entry *catalogEntry
	for i := range entries {
		if entries[i].ID == id {
			entry = &entries[i]
			break
		}
	}
	if entry == nil {
		return nil, "", problemBoth(404, "没有这个插件", "No such plugin")
	}

	name := filepath.Base(entry.File)
	if name != entry.File || name == "." || name == ".." {
		return nil, "", problemBoth(500, "插件目录有误", "The plugin catalog is malformed")
	}
	file, err := os.Open(filepath.Join(a.Config.PluginCatalog, name))
	if err != nil {
		return nil, "", problemBoth(404, "插件文件缺失", "The plugin package is missing")
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxPackageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(body) > maxPackageBytes {
		return nil, "", problemBoth(500, "插件文件过大", "The plugin package is too large")
	}
	if sum := fmt.Sprintf("%x", sha256.Sum256(body)); sum != entry.SHA256 {
		return nil, "", problemBoth(500, "插件文件校验失败", "The plugin package failed its checksum")
	}
	return body, entry.SHA256, nil
}
