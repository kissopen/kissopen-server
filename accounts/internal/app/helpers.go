package app

import (
	"net/http"
	"strconv"
	"strings"
)

func queryInt(r *http.Request, name string, fallback, max int64) int64 {
	v, err := strconv.ParseInt(r.URL.Query().Get(name), 10, 64)
	if err != nil || v <= 0 {
		return fallback
	}
	if v > max {
		return max
	}
	return v
}
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	chars := []rune(s)
	if len(chars) > n {
		return string(chars[:n])
	}
	return s
}
func ownerName(displayName, phone string) string {
	if displayName != "" {
		return displayName
	}
	p := strings.TrimPrefix(phone, "+86")
	if len(p) >= 7 {
		return p[:3] + "****" + p[len(p)-4:]
	}
	return "****"
}
