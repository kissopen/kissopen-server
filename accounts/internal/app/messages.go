package app

import (
	"net/http"
	"strings"
)

func english(r *http.Request) bool {
	return r != nil && strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Accept-Language"))), "en")
}
func (e *apiError) text(en bool) string {
	if !en {
		return e.Message
	}
	if e.English != "" {
		return e.English
	}
	if v, ok := messagesEN[e.Message]; ok {
		return v
	}
	return e.Message
}

var messagesEN = map[string]string{
	"服务暂不可用，请稍后重试": "Service unavailable. Please try again shortly.",
	"服务暂不可用":       "Service unavailable", "请求格式不正确": "Malformed request", "请求内容过大": "Request too large",
	"接口不存在": "Not found", "请先登录": "Please sign in", "内容不存在": "Not found", "账号不存在": "Account not found",
	"请求来源不被允许": "This request origin is not allowed", "缺少请求校验头": "Request verification header missing",
	"昵称最多 40 个字":              "Display names can contain up to 40 characters",
	"用户名为 3–20 位小写字母、数字或下划线":  "Use 3–20 lowercase letters, digits or underscores for your username",
	"这个用户名已被使用":               "This username is already taken",
	"头像为空、过大或格式不正确":           "The avatar is empty, too large or invalid",
	"头像支持 JPEG、PNG 和 WebP 图片": "Avatars support JPEG, PNG and WebP",
	"今日更换头像次数已达上限":            "You have changed your avatar too many times today",
	"请稍后重试":                   "Please try again shortly",
}
