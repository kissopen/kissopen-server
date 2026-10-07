package app

import "net/http"

// CommunityIdentity on the relay is the sole workspace authority. These old
// authenticated endpoints fail explicitly rather than minting an unrelated
// key in the account database. The legacy workspace_accounts table is retained.
func (a *App) workspaceRoutes() {
	a.route("POST /api/workspace/session", true, func(w http.ResponseWriter, r *http.Request, user string) error {
		return problemBoth(410, "请更新客户端以恢复账号工作区，已有数据已保留", "Update your client to restore your account workspace. Existing data was preserved.")
	})
	a.route("POST /api/workspace/authorize", true, func(w http.ResponseWriter, r *http.Request, user string) error {
		return problemBoth(410, "请更新客户端以连接本地 Agent", "Update your client to connect your local Agent.")
	})
}
