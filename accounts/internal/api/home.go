package api

// Persona is what an account says about its work: the industry, the job, whether
// it leads people, and what it wants help with. It shapes the home page and how
// the assistant talks. A questionnaire the person skipped is a Persona with
// Skipped set and nothing else.
type Persona struct {
	// In the person's own words, e.g. "海外电商".
	Industry string `json:"industry"`
	// The job, e.g. "运营" or "行政文员".
	Occupation string `json:"occupation"`
	// individual, manager, owner or student; empty when not said.
	Role string `json:"role"`
	// How many people the account leads; 0 when it leads none.
	TeamSize int64 `json:"team_size"`
	// What the person most wants help with, at most five.
	Goals   []string `json:"goals"`
	Skipped bool     `json:"skipped"`
	Updated int64    `json:"updated"`
}

// PersonaUpdate replaces the account's persona whole.
type PersonaUpdate struct {
	// At most 30 characters.
	Industry string `json:"industry"`
	// At most 30 characters.
	Occupation string `json:"occupation"`
	// individual, manager, owner, student or empty.
	Role string `json:"role"`
	// 0 to 10000.
	TeamSize int64 `json:"team_size"`
	// At most five, each at most 20 characters.
	Goals   []string `json:"goals"`
	Skipped bool     `json:"skipped"`
}
