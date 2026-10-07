package api

// ErrorBody is what every failed request answers with.
type ErrorBody struct {
	// Written for the reader, in Chinese; show it as is.
	Error string `json:"error"`
	// Stable classification; ordinary failures omit it.
	Code string `json:"code,omitempty"`
}

// Ok acknowledges a request that has nothing else to say.
type Ok struct {
	Ok bool `json:"ok"`
}

// Config is what a client needs to know before anyone signs in.
type Config struct {
	CloudAgent  bool   `json:"cloud_agent,omitempty"`
	Name        string `json:"name"`
	NameZh      string `json:"name_zh"`
	Development bool   `json:"development"`
	// No model key is configured, so replies come from a local stand-in.
	DemoModel bool `json:"demo_model"`
	// Phone login can deliver its code; without it there is no way to sign in.
	SMSReady bool `json:"sms_ready"`
	// False when no transcription model is configured, so the mic stays hidden.
	VoiceReady bool `json:"voice_ready"`
}

// User is the signed-in account as the reader may see it. An account is a
// phone number.
type User struct {
	ID string `json:"id"`
	// Masked, e.g. "+8613****0000".
	Phone string `json:"phone"`
	// The whole number, for the account's own settings to reveal on request.
	// Only ever sent to the account it belongs to.
	PhoneNumber string `json:"phone_number"`
	// What the account calls itself; empty until it chooses a name.
	DisplayName string `json:"display_name"`
	// Loads the avatar directly, like MessageImage.url; empty when there is none.
	AvatarURL string `json:"avatar_url"`
	// What the account said about its work; null until the questionnaire is
	// answered or skipped, which is how a client knows to ask.
	Persona *Persona `json:"persona"`
	// The theme the account chose; null for the product's own look.
	Theme *Theme `json:"theme"`
}

// Model is a model a conversation can be answered by.
type Model struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Role says who wrote a message.
type Role string

// Plan is a subscription and the limits it sets. The limits are in 分 of
// model use; they are for proportions and are never shown as amounts.
type Plan struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	PriceFen int64  `json:"price_fen"`
	// Spend allowed in the last five hours, seven days and thirty days; zero
	// means that window is not enforced.
	FiveHourFen int64 `json:"five_hour_fen"`
	WeekFen     int64 `json:"week_fen"`
	MonthFen    int64 `json:"month_fen"`
	// A one-time allowance, spent once and never reset.
	GrantFen int64 `json:"grant_fen"`
}

// Profile is what the account has done, all read from work that happened.
type Profile struct {
	User ProfileUser `json:"user"`
	Plan PlanName    `json:"plan"`
	// Tokens in and out over the account's lifetime.
	LifetimeIn  int64 `json:"lifetime_in"`
	LifetimeOut int64 `json:"lifetime_out"`
	Calls       int64 `json:"calls"`
	// Tokens on the busiest day of the last year.
	PeakDay int64 `json:"peak_day"`
	// Consecutive active days ending today or yesterday, and the longest run.
	CurrentStreak int64 `json:"current_streak"`
	LongestStreak int64 `json:"longest_streak"`
	Chats         int64 `json:"chats"`
	// Messages in the longest conversation.
	LongestChat int64 `json:"longest_chat"`
	Images      int64 `json:"images"`
	Files       int64 `json:"files"`
	// The models used most, busiest first; at most five.
	Models []ModelUse `json:"models"`
	// One entry per day with activity in the last year, oldest first.
	Activity []ActivityDay `json:"activity"`
}

type ProfileUser struct {
	ID string `json:"id"`
	// Masked, like User.phone.
	Phone       string `json:"phone"`
	DisplayName string `json:"display_name"`
	// Lowercase letters, digits and underscores; empty until chosen.
	Username  string `json:"username"`
	AvatarURL string `json:"avatar_url"`
	Created   int64  `json:"created"`
}

// ProfileUpdate changes display name. An empty display name clears it.
// Username is retained for wire compatibility; changes require Security.
type ProfileUpdate struct {
	// At most 40 characters.
	DisplayName *string `json:"display_name,omitempty"`
	// Read-only here. Use the proof-protected Security username endpoint to change it.
	Username *string `json:"username,omitempty"`
}

// AvatarUpload is a new avatar, already cropped to a square by the client and
// sent base64-encoded.
type AvatarUpload struct {
	MIME string `json:"mime"`
	Data string `json:"data"`
}

type PlanName struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ModelUse struct {
	Model  string `json:"model"`
	Runs   int64  `json:"runs"`
	Tokens int64  `json:"tokens"`
}

type ActivityDay struct {
	// The day in the service's time zone, as YYYY-MM-DD.
	Day    string `json:"day"`
	Tokens int64  `json:"tokens"`
}

// WorkspaceSession is what a client needs to reach the reader's workspace.
type WorkspaceSession struct {
	UserID string `json:"user_id"`
	// Base64url; the key the workspace's content is encrypted with.
	Secret    string `json:"secret"`
	Token     string `json:"token"`
	ServerURL string `json:"server_url"`
}

// WorkspaceAuthorizeRequest answers a terminal's pairing request.
type WorkspaceAuthorizeRequest struct {
	Authorization string `json:"authorization"`
}

type WorkspaceAuthorized struct {
	UserID string `json:"user_id"`
	Ok     bool   `json:"ok"`
}

// ThemePalette is one appearance of a theme: the eleven colours every other
// colour of the interface is derived from. Each is "#rrggbb".
type ThemePalette struct {
	// Buttons, links, selection, the brand's line.
	Accent string `json:"accent"`
	// Text on the accent.
	OnAccent string `json:"on_accent"`
	// The window behind everything.
	Canvas string `json:"canvas"`
	// Cards, panels, the composer.
	Surface string `json:"surface"`
	// The sidebar and headers, a step away from the canvas.
	Raised string `json:"raised"`
	Text   string `json:"text"`
	// Secondary text.
	Muted string `json:"muted"`
	// Hairlines and borders.
	Line    string `json:"line"`
	Success string `json:"success"`
	Warning string `json:"warning"`
	Danger  string `json:"danger"`
}

// ThemeBackground is a picture behind the home page and the sidebar.
type ThemeBackground struct {
	// Served by this API; a theme never points anywhere else.
	URL string `json:"url"`
	// How much of the picture shows through the canvas colour, 0.05–1.
	Opacity float64 `json:"opacity"`
	// Pixels of blur, 0–40.
	Blur int `json:"blur"`
}

// ThemeDoc is the theme itself: what a client draws, a model writes, and a
// person exports and imports.
type ThemeDoc struct {
	// 1.
	Version int `json:"version"`
	// "sans", "serif" or "mono".
	Font string `json:"font"`
	// "sharp", "soft" or "round".
	Radius     string           `json:"radius"`
	Light      ThemePalette     `json:"light"`
	Dark       ThemePalette     `json:"dark"`
	Background *ThemeBackground `json:"background,omitempty"`
}

// Theme is a theme as the product lists it.
type Theme struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// "system", "ai" or "user".
	Source string `json:"source"`
	// Who made it, as others see them; empty for the product's own.
	Owner string `json:"owner"`
	// The signed-in account made it.
	Mine bool `json:"mine"`
	// In the gallery for everyone.
	Public   bool `json:"public"`
	Featured bool `json:"featured"`
	// Accounts using it.
	Uses    int      `json:"uses"`
	Created int64    `json:"created"`
	Updated int64    `json:"updated"`
	Doc     ThemeDoc `json:"doc"`
}

// ThemesPage is the theme settings page: what is chosen, what is built in,
// what the account made, and what the gallery features.
type ThemesPage struct {
	// The chosen theme's id; empty for the product's own look.
	Selected string  `json:"selected"`
	System   []Theme `json:"system"`
	Mine     []Theme `json:"mine"`
	Featured []Theme `json:"featured"`
	// Whether the account may ask a model for a theme right now.
	CanGenerate bool `json:"can_generate"`
}

// ThemeGalleryRequest is a page of the gallery asked for by POST.
type ThemeGalleryRequest struct {
	Q string `json:"q"`
	// "uses" (the default) or "new".
	Sort   string `json:"sort"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}

// ThemeGallery is a page of the themes people published.
type ThemeGallery struct {
	Themes []Theme `json:"themes"`
	Total  int     `json:"total"`
}

// ThemeWrite makes or changes a theme of the account's own.
type ThemeWrite struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// "user" for one made or imported by hand, "ai" for one a model wrote.
	Source string   `json:"source"`
	Doc    ThemeDoc `json:"doc"`
}

// ThemeSelect chooses a theme for the account; an empty id is the product's own look.
type ThemeSelect struct {
	ID string `json:"id"`
}

// ThemeSelected is the account's theme after choosing; null for the product's own look.
type ThemeSelected struct {
	Theme *Theme `json:"theme"`
}

// ThemeImageUpload is a picture for a theme's background, base64 in Data.
type ThemeImageUpload struct {
	MIME string `json:"mime"`
	Data string `json:"data"`
}

// ThemeImage is where an uploaded picture is served from.
type ThemeImage struct {
	URL string `json:"url"`
}
