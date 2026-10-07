package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

// Opt-in smoke against a disposable PostgreSQL database, including a schema-only
// copy of an older deployment. Never accept a live database name.
func TestDeploymentPostgres(t *testing.T) {
	dsn := os.Getenv("KISSOPEN_TEST_DATABASE")
	if dsn == "" {
		t.Skip("set KISSOPEN_TEST_DATABASE to a disposable database")
	}
	u, err := url.Parse(dsn)
	if err != nil || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "kissopen_deploy_test_") {
		t.Fatal("refusing non-test database")
	}
	tokens := map[string]string{
		"Bearer deployment-test-owner-token": "deployment-owner",
		"Bearer deployment-test-other-token": "deployment-other",
	}
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity := tokens[r.Header.Get("Authorization")]
		if r.URL.Path != "/v1/community/account" || identity == "" {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(communityIdentity{ID: identity, Provider: "nodeloc", Name: "Deployment fixture"})
	}))
	defer relay.Close()
	a, err := New(Config{Mode: "development", Database: dsn, ImageDir: t.TempDir(), Secret: strings.Repeat("t", 48), PublicURL: "http://127.0.0.1:8081", CommunityAuthURL: relay.URL, WorkspaceURL: relay.URL, PluginCatalog: os.Getenv("KISSOPEN_TEST_CATALOG")})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Store.DB.Close()
	request := func(method, path, token string, body any, status int) map[string]any {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: got %d, want %d", method, path, w.Code, status)
		}
		var out map[string]any
		if json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("%s: response is not JSON", path)
		}
		return out
	}
	owner, other := "deployment-test-owner-token", "deployment-test-other-token"
	me := request("GET", "/api/me", owner, nil, 200)
	if me["id"] == "" || me["id"] == nil {
		t.Fatal("missing stable account")
	}
	request("POST", "/api/profile", owner, map[string]string{"display_name": "Smoke owner"}, 200)
	profile := request("GET", "/api/profile", owner, nil, 200)
	if profile["user"].(map[string]any)["display_name"] != "Smoke owner" {
		t.Fatal("profile did not persist")
	}
	otherMe := request("GET", "/api/me", other, nil, 200)
	if otherMe["id"] == me["id"] || otherMe["display_name"] == "Smoke owner" {
		t.Fatal("account isolation failed")
	}
	request("GET", "/api/themes", owner, nil, 200)
	request("POST", "/api/themes/select", owner, map[string]string{"id": "sys-kissopen"}, 200)
	if request("GET", "/api/themes", owner, nil, 200)["selected"] != "sys-kissopen" {
		t.Fatal("theme selection did not persist")
	}
	if a.Config.PluginCatalog != "" {
		plugins := request("GET", "/api/cloud/catalog", owner, nil, 200)["plugins"].([]any)
		if len(plugins) == 0 {
			t.Fatal("missing deployed catalog")
		}
		id := plugins[0].(map[string]any)["id"].(string)
		request("GET", "/api/cloud/catalog/"+id, owner, nil, 200)
		request("GET", "/api/cloud/catalog/"+id+"/package", owner, nil, 200)
		t.Logf("verified %d catalog entries and first package checksum", len(plugins))
	}
	request("GET", "/api/admin/users", owner, nil, 403)
	request("POST", "/api/auth/logout", owner, map[string]any{}, 200)
	request("GET", "/api/me", owner, nil, 401)
	request("GET", "/api/me", other, nil, 200)
}
