package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testApp() *App {
	a := &App{Config: Config{Mode: "development", PublicURL: "http://127.0.0.1:8081"}, mux: http.NewServeMux()}
	a.routes()
	return a
}
func TestRemovedCommercialRoutes(t *testing.T) {
	a := testApp()
	for _, path := range []string{"/api/billing", "/api/pay/epay/create", "/api/usage", "/api/models", "/api/chat", "/api/cloud/workspace", "/api/cloud/agent/v0", "/api/schedules", "/api/home", "/api/agent/v1/messages", "/api/admin/agent-routing/preview"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			a.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
			if w.Code != 404 {
				t.Fatalf("got %d, want 404", w.Code)
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["error"] == nil {
				t.Fatal("missing friendly JSON error")
			}
		})
	}
}
func TestAccountConfigHasNoCloudCapabilities(t *testing.T) {
	w := httptest.NewRecorder()
	testApp().ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"cloud_agent", "sms_ready", "voice_ready", "demo_model"} {
		if body[key] == true {
			t.Fatalf("unexpected enabled capability %s", key)
		}
	}
}
func TestPrivateRoutesRequireSignIn(t *testing.T) {
	for _, path := range []string{"/api/me", "/api/profile", "/api/themes", "/api/cloud/catalog", "/api/cloud/catalog/demo/package", "/api/admin/me", "/api/admin/themes", "/api/admin/users"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			testApp().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
			if w.Code != 401 {
				t.Fatalf("got %d, want 401", w.Code)
			}
		})
	}
}
func TestCrossOriginWritesRejected(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/profile", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://untrusted.example")
	req.Header.Set("Authorization", "Bearer fake-token")
	w := httptest.NewRecorder()
	testApp().ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("got %d, want 403", w.Code)
	}
}
func TestConfigValidation(t *testing.T) {
	c := Config{Mode: "production", PublicURL: "https://kissopen.example", CommunityAuthURL: "http://127.0.0.1:3005", WorkspaceURL: "https://kissopen.example", Secret: strings.Repeat("x", 32)}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Secret = "short"
	if c.Validate() == nil {
		t.Fatal("accepted unsafe production secret")
	}
	c.Secret = strings.Repeat("x", 32)
	c.CommunityAuthURL = "https://user:password@example.com"
	if c.Validate() == nil {
		t.Fatal("accepted credentials in auth origin")
	}
}
func TestCatalogNamesAndThemeBodyLimit(t *testing.T) {
	for _, name := range []string{"../secret", "apply", "credentials", "MixedCase"} {
		if validPluginName(name) {
			t.Fatalf("accepted unsafe plugin name %q", name)
		}
	}
	if !validPluginName("local-tools") {
		t.Fatal("rejected valid plugin name")
	}
	if bodyLimit("/api/themes/images") <= themeImageMax {
		t.Fatal("base64 upload envelope does not fit")
	}
}
