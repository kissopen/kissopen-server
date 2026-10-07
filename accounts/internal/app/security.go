package app

import (
	"io"
	"net/http"
	"strings"
)

// Only these account-security operations may be forwarded. The relay remains
// the single authentication authority; no password or MFA secret is stored here.
func (a *App) securityRoutes() {
	paths := []string{"verify", "username", "password", "totp/begin", "totp/confirm", "totp/disable", "recovery", "oauth/start", "oauth/complete", "oauth/unlink"}
	a.route("GET /api/security", true, a.securityProxy)
	for _, path := range paths {
		a.route("POST /api/security/"+path, true, a.securityProxy)
	}
}
func (a *App) securityProxy(w http.ResponseWriter, r *http.Request, _ string) error {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, a.Config.CommunityAuthURL+"/v1/community/security"+strings.TrimPrefix(r.URL.Path, "/api/security"), io.LimitReader(r.Body, 16*1024+1))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	req.Header.Set("Content-Type", "application/json")
	response, err := communityHTTP.Do(req)
	if err != nil {
		return problemBoth(503, "安全服务暂时无法连接，请稍后再试", "Security service is temporarily unavailable. Please try again shortly.")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 32*1024+1))
	if err != nil || len(data) > 32*1024 {
		return problem(503, "服务暂不可用，请稍后重试")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(response.StatusCode)
	_, err = w.Write(data)
	return err
}
