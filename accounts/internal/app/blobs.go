package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

/*
Where a picture's bytes live.

The row keeps a key like `ab/abc123.png`; what stands behind the key is this.
Two backings: a directory, which is what a development box and the first
deployments had, and Aliyun OSS, which is what lets the business server stop
being the one machine the pictures are on. Nothing above this layer knows
which it is talking to — the same key opens the same bytes either way — so
moving a deployment is copying the directory into the bucket and changing
five environment variables.
*/
type Blobs interface {
	// Put stores bytes under a key. A key that exists is overwritten; a reader
	// never sees a half-written object.
	Put(key, mime string, data []byte) error
	Get(key string) ([]byte, error)
	// Delete forgets a key. A key already gone is not an error.
	Delete(key string) error
}

// OSS is what an Aliyun OSS bucket needs to be spoken to. Empty means a
// directory is used instead.
type OSS struct {
	Endpoint, Region, Bucket, AccessKeyID, AccessKeySecret string
}

// Configured reports whether a bucket has been named at all.
func (o OSS) Configured() bool { return o.Bucket != "" }

// blobsFor picks the backing the configuration names.
func blobsFor(c Config) (Blobs, error) {
	if c.OSS.Configured() {
		return ossBlobsOpen(c.OSS)
	}
	return dirBlobsOpen(c.ImageDir)
}

// DirBlobs is the directory backing, for tools that run beside the server.
func DirBlobs(root string) (Blobs, error) { return dirBlobsOpen(root) }

// dirBlobs keeps each key as a file under one directory.
type dirBlobs struct{ root string }

func dirBlobsOpen(root string) (*dirBlobs, error) {
	if e := os.MkdirAll(root, 0700); e != nil {
		return nil, e
	}
	return &dirBlobs{root: root}, nil
}

// path is where a key's bytes are. The key is one this store wrote, never one
// a client supplied, but it is still confined to the directory rather than
// trusted to stay there.
func (d *dirBlobs) path(key string) (string, error) {
	full := filepath.Join(d.root, filepath.FromSlash(key))
	if !strings.HasPrefix(full, filepath.Clean(d.root)+string(filepath.Separator)) {
		return "", fmt.Errorf("blob key outside store: %q", key)
	}
	return full, nil
}

// Put lands the bytes under a temporary name and renames them into place, so
// a reader never sees half a picture.
func (d *dirBlobs) Put(key, _ string, data []byte) error {
	full, e := d.path(key)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(full), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(full), ".upload-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	if ce := f.Close(); e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), full)
}

func (d *dirBlobs) Get(key string) ([]byte, error) {
	full, e := d.path(key)
	if e != nil {
		return nil, e
	}
	return os.ReadFile(full)
}

func (d *dirBlobs) Delete(key string) error {
	full, e := d.path(key)
	if e != nil {
		return e
	}
	if e = os.Remove(full); e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	return nil
}

// ossBlobs keeps each key as an object in one bucket.
type ossBlobs struct {
	client *oss.Client
	bucket string
}

// How long one object operation may take. Pictures are small — an upload is
// at most 700 KB — so anything longer is a bucket that is not answering.
const ossTimeout = 30 * time.Second

func ossBlobsOpen(o OSS) (*ossBlobs, error) {
	if o.Region == "" || o.AccessKeyID == "" || o.AccessKeySecret == "" {
		return nil, fmt.Errorf("CN_OSS_REGION, CN_OSS_ACCESS_KEY_ID and CN_OSS_ACCESS_KEY_SECRET are required with CN_OSS_BUCKET")
	}
	cfg := oss.LoadDefaultConfig().
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(o.AccessKeyID, o.AccessKeySecret)).
		WithRegion(o.Region)
	if o.Endpoint != "" {
		cfg = cfg.WithEndpoint(o.Endpoint)
	}
	return &ossBlobs{client: oss.NewClient(cfg), bucket: o.Bucket}, nil
}

func (b *ossBlobs) Put(key, mime string, data []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), ossTimeout)
	defer cancel()
	request := &oss.PutObjectRequest{Bucket: oss.Ptr(b.bucket), Key: oss.Ptr(key), Body: bytes.NewReader(data)}
	if mime != "" {
		request.ContentType = oss.Ptr(mime)
	}
	_, e := b.client.PutObject(ctx, request)
	return e
}

func (b *ossBlobs) Get(key string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ossTimeout)
	defer cancel()
	result, e := b.client.GetObject(ctx, &oss.GetObjectRequest{Bucket: oss.Ptr(b.bucket), Key: oss.Ptr(key)})
	if e != nil {
		return nil, e
	}
	defer result.Body.Close()
	return io.ReadAll(io.LimitReader(result.Body, 32<<20))
}

func (b *ossBlobs) Delete(key string) error {
	ctx, cancel := context.WithTimeout(context.Background(), ossTimeout)
	defer cancel()
	_, e := b.client.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(b.bucket), Key: oss.Ptr(key)})
	return e
}

// OSSBlobsFromEnvironment opens the bucket the CN_OSS_* variables name, for
// the migration tool that runs beside the server rather than inside it.
func OSSBlobsFromEnvironment() (Blobs, error) {
	o := OSS{Endpoint: os.Getenv("CN_OSS_ENDPOINT"), Region: os.Getenv("CN_OSS_REGION"), Bucket: os.Getenv("CN_OSS_BUCKET"), AccessKeyID: os.Getenv("CN_OSS_ACCESS_KEY_ID"), AccessKeySecret: os.Getenv("CN_OSS_ACCESS_KEY_SECRET")}
	if !o.Configured() {
		return nil, fmt.Errorf("CN_OSS_BUCKET is not set")
	}
	return ossBlobsOpen(o)
}
