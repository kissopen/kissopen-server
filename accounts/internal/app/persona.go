package app

import (
	"encoding/json"

	"net/http"
	"strings"

	"unicode/utf8"

	"kissopen.local/accounts/internal/api"
)

var personaRoles = map[string]bool{"": true, "individual": true, "manager": true, "owner": true, "student": true}

// persona reads what the account said about its work; nil until it answered or skipped.
func (a *App) persona(q querier, u string) *api.Persona {
	raw := str(one(q, "SELECT persona_json FROM users WHERE id=?", u)["persona_json"])
	if raw == "" {
		return nil
	}
	var p api.Persona
	if json.Unmarshal([]byte(raw), &p) != nil {
		return nil
	}
	if p.Goals == nil {
		p.Goals = []string{}
	}
	return &p
}

func (a *App) personaUpdate(w http.ResponseWriter, r *http.Request, u string) error {
	in, err := read[api.PersonaUpdate](r)
	if err != nil {
		return err
	}
	clean := func(v string, limit int) (string, bool) {
		v = strings.TrimSpace(v)
		return v, utf8.RuneCountInString(v) <= limit
	}
	p := api.Persona{Skipped: in.Skipped, Goals: []string{}, Updated: now()}
	var ok bool
	if p.Industry, ok = clean(in.Industry, 30); !ok {
		return problemBoth(400, "行业最多 30 个字", "The industry is at most 30 characters")
	}
	if p.Occupation, ok = clean(in.Occupation, 30); !ok {
		return problemBoth(400, "职业最多 30 个字", "The job is at most 30 characters")
	}
	if !personaRoles[in.Role] {
		return problemBoth(400, "身份不正确", "Unknown role")
	}
	p.Role = in.Role
	if in.TeamSize < 0 || in.TeamSize > 10000 {
		return problemBoth(400, "团队人数不正确", "The team size is out of range")
	}
	p.TeamSize = in.TeamSize
	if len(in.Goals) > 5 {
		return problemBoth(400, "最多选 5 个目的", "Choose at most five goals")
	}
	for _, goal := range in.Goals {
		goal, fits := clean(goal, 20)
		if !fits {
			return problemBoth(400, "每个目的最多 20 个字", "Each goal is at most 20 characters")
		}
		if goal != "" {
			p.Goals = append(p.Goals, goal)
		}
	}
	if p.Skipped {
		p = api.Persona{Skipped: true, Goals: []string{}, Updated: p.Updated}
	}
	encoded, _ := json.Marshal(p)
	exec(a.Store.DB, "UPDATE users SET persona_json=? WHERE id=?", string(encoded), u)
	respond(w, 200, p)
	return nil
}
