package app

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	Mode, Addr, Database, ImageDir, PublicURL, Secret string
	CommunityAuthURL, WorkspaceURL, PluginCatalog     string
	ClientOrigins                                     []string
	AdminIdentities                                   []string
	OSS                                               OSS
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func LoadConfig() (Config, error) {
	c := Config{
		Mode: env("CN_MODE", "development"), Addr: env("CN_ADDR", "127.0.0.1:8081"),
		Database: env("CN_DATABASE", "postgres://localhost/kissopen_accounts?sslmode=disable"),
		ImageDir: env("CN_IMAGE_DIR", "data/images"), PublicURL: env("CN_PUBLIC_URL", "http://127.0.0.1:8081"),
		Secret:           env("CN_SECRET", "development-only-change-before-deploy"),
		CommunityAuthURL: env("KISSOPEN_COMMUNITY_AUTH_URL", "http://127.0.0.1:3005"),
		WorkspaceURL:     env("CN_WORKSPACE_URL", env("CN_PUBLIC_URL", "http://127.0.0.1:3005")),
		PluginCatalog:    env("KISSOPEN_PLUGIN_CATALOG", os.Getenv("CN_CLOUD_PLUGIN_CATALOG")),
		OSS:              OSS{Endpoint: os.Getenv("CN_OSS_ENDPOINT"), Region: os.Getenv("CN_OSS_REGION"), Bucket: os.Getenv("CN_OSS_BUCKET"), AccessKeyID: os.Getenv("CN_OSS_ACCESS_KEY_ID"), AccessKeySecret: os.Getenv("CN_OSS_ACCESS_KEY_SECRET")},
	}
	for _, v := range strings.Split(os.Getenv("CN_CLIENT_ORIGINS"), ",") {
		if v = strings.TrimSpace(v); v != "" {
			c.ClientOrigins = append(c.ClientOrigins, v)
		}
	}
	for _, v := range strings.Split(os.Getenv("KISSOPEN_ADMIN_IDENTITIES"), ",") {
		if v = strings.TrimSpace(v); v != "" {
			c.AdminIdentities = append(c.AdminIdentities, v)
		}
	}
	return c, c.Validate()
}
func (c Config) Dev() bool { return c.Mode == "development" }
func (c Config) Validate() error {
	if c.Mode != "development" && c.Mode != "production" {
		return fmt.Errorf("CN_MODE must be development or production")
	}
	if !c.Dev() && (len(c.Secret) < 32 || c.Secret == "development-only-change-before-deploy") {
		return fmt.Errorf("CN_SECRET must be an independently generated secret of at least 32 characters")
	}
	for key, value := range map[string]string{"CN_PUBLIC_URL": c.PublicURL, "KISSOPEN_COMMUNITY_AUTH_URL": c.CommunityAuthURL, "CN_WORKSPACE_URL": c.WorkspaceURL} {
		u, err := url.Parse(value)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
			return fmt.Errorf("%s must be an HTTPS or loopback HTTP origin", key)
		}
	}
	for _, origin := range c.ClientOrigins {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && !(c.Dev() && u.Scheme == "http")) {
			return fmt.Errorf("invalid CN_CLIENT_ORIGINS entry")
		}
	}
	return nil
}
