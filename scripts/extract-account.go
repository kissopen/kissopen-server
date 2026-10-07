//go:build ignore

// One-time AST extraction of reusable account handlers. No commercial execution
// code is copied. Imports are retained only when used by selected declarations.
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func names(d ast.Decl) []string {
	switch v := d.(type) {
	case *ast.FuncDecl:
		return []string{v.Name.Name}
	case *ast.GenDecl:
		var result []string
		for _, s := range v.Specs {
			switch x := s.(type) {
			case *ast.TypeSpec:
				result = append(result, x.Name.Name)
			case *ast.ValueSpec:
				for _, n := range x.Names {
					result = append(result, n.Name)
				}
			}
		}
		return result
	}
	return nil
}

func main() {
	if len(os.Args) != 3 {
		panic("usage: extract-account.go SOURCE_ACCOUNT DESTINATION_ACCOUNT")
	}
	src, dst := os.Args[1], os.Args[2]
	if _, err := os.Stat(filepath.Join(dst, "internal")); err == nil {
		panic("refusing to overwrite existing handlers")
	}
	selected := map[string]string{
		"server.go":    "apiError Error problem problemBoth respond fail read signature handler route ServeHTTP allowedOrigin token owned rate maskPhone bodyLimit agentBodyLimit",
		"store.go":     "M id now js str num querier exec all one Store userKey lockRate lockKey Tx schemaApply ImageWrite imageRead rebind lockSchema",
		"blobs.go":     "*",
		"community.go": "*",
		"profile.go":   "profileUser usernamePattern profileUpdate avatarUpload",
		"themes.go":    "*",
		"images.go":    "dayMillis avatarURL signedURL signature signedExpiry avatar serveStored",
		"home.go":      "personaRoles persona personaUpdate",
		"wire.go":      "rowAs rowsAs fields fill arrays wire",
		"worker.go":    "imageExtension",
		"cloud.go":     "catalogEntry catalogEntries cloudCatalog cloudCatalogDetail cloudCatalogPackage catalogPackage",
		"workspace.go": "escrow workspaceSecret workspaceRelay workspaceToken workspaceRoutes workspaceURL",
	}
	for file, list := range selected {
		fs := token.NewFileSet()
		f, err := parser.ParseFile(fs, filepath.Join(src, "internal/app", file), nil, parser.ParseComments)
		must(err)
		wanted := map[string]bool{}
		for _, n := range strings.Fields(list) {
			wanted[n] = true
		}
		var decls []ast.Decl
		for _, d := range f.Decls {
			ns := names(d)
			keep := wanted["*"] && len(ns) > 0
			for _, n := range ns {
				keep = keep || wanted[n]
			}
			if file == "themes.go" {
				for _, n := range ns {
					if n == "themeModel" || n == "themeGenerateSystem" || n == "themeGenerate" {
						keep = false
					}
				}
			}
			if keep {
				decls = append(decls, d)
			}
		}
		output(fs, f, decls, filepath.Join(dst, "internal/app", file))
	}
	// Select public types and their transitive dependencies, not billing DTOs.
	fs := token.NewFileSet()
	files := map[string]*ast.File{}
	declByName := map[string]ast.Decl{}
	for _, name := range []string{"api.go", "home.go", "plugins.go"} {
		f, err := parser.ParseFile(fs, filepath.Join(src, "internal/api", name), nil, parser.ParseComments)
		must(err)
		files[name] = f
		for _, d := range f.Decls {
			for _, n := range names(d) {
				declByName[n] = d
			}
		}
	}
	keep := map[ast.Decl]bool{}
	var selectName func(string)
	selectName = func(n string) {
		d := declByName[n]
		if d == nil || keep[d] {
			return
		}
		keep[d] = true
		ast.Inspect(d, func(node ast.Node) bool {
			if i, ok := node.(*ast.Ident); ok {
				selectName(i.Name)
			}
			return true
		})
	}
	for _, n := range strings.Fields("Config ErrorBody Ok User Profile ProfileUser ProfileUpdate AvatarUpload Persona PersonaUpdate WorkspaceSession WorkspaceAuthorizeRequest WorkspaceAuthorized Theme ThemesPage ThemeGalleryRequest ThemeGallery ThemeWrite ThemeSelect ThemeSelected ThemeImageUpload ThemeImage CatalogPackage") {
		selectName(n)
	}
	for name, f := range files {
		var ds []ast.Decl
		for _, d := range f.Decls {
			if keep[d] {
				ds = append(ds, d)
			}
		}
		output(fs, f, ds, filepath.Join(dst, "internal/api", name))
	}
	fmt.Println("Extracted account/profile/theme/catalog handlers and public type closure; no billing, model, worker or board handlers.")
}

func output(fs *token.FileSet, original *ast.File, decls []ast.Decl, path string) {
	used := map[string]bool{}
	for _, d := range decls {
		ast.Inspect(d, func(n ast.Node) bool {
			if s, ok := n.(*ast.SelectorExpr); ok {
				if x, ok := s.X.(*ast.Ident); ok {
					used[x.Name] = true
				}
			}
			return true
		})
	}
	var imports []ast.Spec
	for _, im := range original.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		name := filepath.Base(p)
		if im.Name != nil {
			name = im.Name.Name
		}
		if used[name] || name == "_" {
			im.Path.Value = strconv.Quote(strings.ReplaceAll(p, "github.com/nodeloc/kissopen/internal/", "kissopen.local/accounts/internal/"))
			imports = append(imports, im)
		}
	}
	if len(imports) > 0 {
		decls = append([]ast.Decl{&ast.GenDecl{Tok: token.IMPORT, Specs: imports}}, decls...)
	}
	f := &ast.File{Name: ast.NewIdent(original.Name.Name), Decls: decls}
	var b bytes.Buffer
	must(format.Node(&b, fs, f))
	must(os.MkdirAll(filepath.Dir(path), 0755))
	must(os.WriteFile(path, b.Bytes(), 0644))
}
func must(e error) {
	if e != nil {
		panic(e)
	}
}
