package api

// CatalogPackage is a verified archive for installation on the caller's computer.
type CatalogPackage struct {
	ID      string `json:"id"`
	SHA256  string `json:"sha256"`
	Archive string `json:"archive"`
}
