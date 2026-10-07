package app

import (
	"fmt"
	"reflect"
	"strings"
)

// rowAs fills one of the api types from a query row, matching columns to
// fields by JSON name. A column with no field is a query and a contract that
// disagree, and fails loudly rather than being dropped; a field with no column
// keeps its zero value for the handler to fill.
func rowAs[T any](m M) T {
	var v T
	fill(reflect.ValueOf(&v).Elem(), m)
	return v
}

func rowsAs[T any](ms []M) []T {
	out := make([]T, len(ms))
	for i, m := range ms {
		out[i] = rowAs[T](m)
	}
	return out
}

// fields maps each JSON name to its field, including those of embedded
// structs, which JSON flattens into the same object.
func fields(v reflect.Value, into map[string]reflect.Value) {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.Anonymous && f.Type.Kind() == reflect.Struct {
			fields(v.Field(i), into)
			continue
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			into[name] = v.Field(i)
		}
	}
}

func fill(v reflect.Value, m M) {
	byName := map[string]reflect.Value{}
	fields(v, byName)
	for column, value := range m {
		field, ok := byName[column]
		if !ok {
			panic(fmt.Errorf("column %q has no field in %s", column, v.Type()))
		}
		if value == nil {
			continue
		}
		target := field
		if field.Kind() == reflect.Pointer {
			target = reflect.New(field.Type().Elem()).Elem()
		}
		switch target.Kind() {
		case reflect.String:
			target.SetString(str(value))
		case reflect.Int, reflect.Int64:
			target.SetInt(num(value))
		case reflect.Bool:
			switch b := value.(type) {
			case bool:
				target.SetBool(b)
			default:
				target.SetBool(num(value) != 0)
			}
		default:
			panic(fmt.Errorf("column %q cannot fill %s", column, target.Type()))
		}
		if field.Kind() == reflect.Pointer {
			field.Set(target.Addr())
		}
	}
}

// arrays replaces every nil slice with an empty one. The contract promises a
// client an array wherever there is a list, and JSON would otherwise send an
// empty Go slice as null.
func arrays(v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			arrays(v.Elem())
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				arrays(v.Field(i))
			}
		}
	case reflect.Slice:
		if v.IsNil() && v.CanSet() {
			v.Set(reflect.MakeSlice(v.Type(), 0, 0))
		}
		for i := 0; i < v.Len(); i++ {
			arrays(v.Index(i))
		}
	}
}

// wire prepares a response body for the wire: a struct or slice from the api
// package with every list present.
func wire(data any) any {
	if data == nil {
		return data
	}
	v := reflect.New(reflect.TypeOf(data))
	v.Elem().Set(reflect.ValueOf(data))
	arrays(v.Elem())
	return v.Elem().Interface()
}
