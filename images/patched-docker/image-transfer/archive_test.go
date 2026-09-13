package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"testing"

	digest "github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/specs-go"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

func fixture(t *testing.T) []byte {
	t.Helper()
	cb := []byte(`{"architecture":"arm64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}`)
	config := ocispec.Descriptor{MediaType: ocispec.MediaTypeImageConfig, Digest: digest.FromBytes(cb), Size: int64(len(cb))}
	mb, err := json.Marshal(ocispec.Manifest{Versioned: specs.Versioned{SchemaVersion: 2}, MediaType: ocispec.MediaTypeImageManifest, Config: config, Layers: []ocispec.Descriptor{}})
	if err != nil {
		t.Fatal(err)
	}
	manifest := ocispec.Descriptor{MediaType: ocispec.MediaTypeImageManifest, Digest: digest.FromBytes(mb), Size: int64(len(mb))}
	var out bytes.Buffer
	if err := writeArchive(&out, "docker.io/library/example:test", manifest, config, map[string][]byte{blobPath(manifest): mb, blobPath(config): cb}); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestMetadataArchive(t *testing.T) {
	archive, err := readArchive(bytes.NewReader(fixture(t)))
	if err != nil {
		t.Fatal(err)
	}
	if archive.name != "docker.io/library/example:test" || len(archive.blobs) != 2 {
		t.Fatalf("unexpected metadata: %#v", archive)
	}
}

func TestRejectCorruptMetadataBeforeImport(t *testing.T) {
	data := fixture(t)
	data = bytes.Replace(data, []byte(`"architecture":"arm64"`), []byte(`"architecture":"amd64"`), 1)
	if _, err := readArchive(bytes.NewReader(data)); err == nil {
		t.Fatal("accepted corrupt configuration")
	}
}

func TestRejectArchiveEntries(t *testing.T) {
	for _, test := range []struct {
		name   string
		header tar.Header
	}{
		{"symlink", tar.Header{Name: "oci-layout", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}},
		{"oversize", tar.Header{Name: "oci-layout", Typeflag: tar.TypeReg, Size: maxMetadataBytes + 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var b bytes.Buffer
			tw := tar.NewWriter(&b)
			if err := tw.WriteHeader(&test.header); err != nil {
				t.Fatal(err)
			}
			if _, err := readArchive(bytes.NewReader(b.Bytes())); err == nil {
				t.Fatal("accepted invalid archive entry")
			}
		})
	}
}
