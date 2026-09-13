package main

import (
	"archive/tar"
	"bytes"
	_ "crypto/sha256"
	_ "crypto/sha512"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/containerd/containerd/v2/core/images"
	"github.com/distribution/reference"
	digest "github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/specs-go"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// This transport deliberately supports one image manifest and its configuration,
// not arbitrary OCI archives, layers, attestations, or referrers.
const maxMetadataBytes = 32 << 20

type metadataArchive struct {
	name     string
	target   ocispec.Descriptor
	manifest ocispec.Manifest
	config   ocispec.Image
	blobs    map[string][]byte
}

func blobPath(d ocispec.Descriptor) string {
	return "blobs/" + d.Digest.Algorithm().String() + "/" + d.Digest.Encoded()
}

func namedTag(value string) (string, error) {
	parsed, err := reference.ParseNormalizedNamed(value)
	if err != nil {
		return "", err
	}
	if _, ok := parsed.(reference.Digested); ok {
		return "", fmt.Errorf("image name must have a tag, without a digest: %s", value)
	}
	return reference.TagNameOnly(parsed).String(), nil
}

func checkedBlob(blobs map[string][]byte, d ocispec.Descriptor) ([]byte, error) {
	if err := d.Digest.Validate(); err != nil {
		return nil, err
	}
	b, ok := blobs[blobPath(d)]
	if !ok {
		return nil, fmt.Errorf("missing metadata blob %s", d.Digest)
	}
	if d.Size != int64(len(b)) || d.Digest.Algorithm().FromBytes(b) != d.Digest {
		return nil, fmt.Errorf("metadata digest or size mismatch: %s", d.Digest)
	}
	return b, nil
}

func readArchive(r io.Reader) (*metadataArchive, error) {
	tr := tar.NewReader(r)
	files := map[string][]byte{}
	var size int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read metadata archive: %w", err)
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return nil, fmt.Errorf("metadata archive entry must be a regular file: %s", h.Name)
		}
		size += h.Size
		if h.Size < 0 || size > maxMetadataBytes || len(files) >= 4 {
			return nil, fmt.Errorf("metadata archive exceeds four files or %d bytes", maxMetadataBytes)
		}
		if _, exists := files[h.Name]; exists {
			return nil, fmt.Errorf("duplicate archive entry: %s", h.Name)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		files[h.Name] = b
	}
	var layout ocispec.ImageLayout
	if err := json.Unmarshal(files["oci-layout"], &layout); err != nil {
		return nil, fmt.Errorf("oci-layout: %w", err)
	}
	if layout.Version != ocispec.ImageLayoutVersion {
		return nil, fmt.Errorf("unsupported OCI layout version %q", layout.Version)
	}
	var index ocispec.Index
	if err := json.Unmarshal(files["index.json"], &index); err != nil {
		return nil, fmt.Errorf("index.json: %w", err)
	}
	if index.SchemaVersion != 2 || len(index.Manifests) != 1 {
		return nil, fmt.Errorf("archive must describe exactly one image manifest")
	}
	target := index.Manifests[0]
	name, err := namedTag(target.Annotations[ocispec.AnnotationRefName])
	if err != nil {
		return nil, fmt.Errorf("image name: %w", err)
	}
	if !images.IsManifestType(target.MediaType) {
		return nil, fmt.Errorf("archive target must be an image manifest, got %s", target.MediaType)
	}
	mb, err := checkedBlob(files, target)
	if err != nil {
		return nil, err
	}
	var manifest ocispec.Manifest
	if err := json.Unmarshal(mb, &manifest); err != nil {
		return nil, err
	}
	if manifest.SchemaVersion != 2 || !images.IsConfigType(manifest.Config.MediaType) || manifest.Subject != nil {
		return nil, fmt.Errorf("unsupported image manifest")
	}
	cb, err := checkedBlob(files, manifest.Config)
	if err != nil {
		return nil, err
	}
	if len(files) != 4 {
		return nil, fmt.Errorf("archive must contain only layout, index, manifest and configuration")
	}
	var config ocispec.Image
	if err := json.Unmarshal(cb, &config); err != nil {
		return nil, err
	}
	if config.RootFS.Type != "layers" || len(config.RootFS.DiffIDs) != len(manifest.Layers) {
		return nil, fmt.Errorf("configuration diffIDs do not match manifest layers")
	}
	if config.OS != "linux" {
		return nil, fmt.Errorf("EROFS requires a Linux image")
	}
	for i, layer := range manifest.Layers {
		if !images.IsLayerType(layer.MediaType) || layer.Size < 0 {
			return nil, fmt.Errorf("invalid layer descriptor %d", i)
		}
		for _, d := range []digest.Digest{layer.Digest, config.RootFS.DiffIDs[i]} {
			if err := d.Validate(); err != nil {
				return nil, err
			}
		}
	}
	return &metadataArchive{name, target, manifest, config, map[string][]byte{blobPath(target): mb, blobPath(manifest.Config): cb}}, nil
}

func writeArchive(w io.Writer, name string, target ocispec.Descriptor, config ocispec.Descriptor, blobs map[string][]byte) error {
	target.Annotations = map[string]string{ocispec.AnnotationRefName: name}
	index, err := json.Marshal(ocispec.Index{Versioned: specs.Versioned{SchemaVersion: 2}, MediaType: ocispec.MediaTypeImageIndex, Manifests: []ocispec.Descriptor{target}})
	if err != nil {
		return err
	}
	tw := tar.NewWriter(w)
	for _, entry := range []struct {
		name string
		data []byte
	}{
		{"oci-layout", []byte(`{"imageLayoutVersion":"1.0.0"}`)}, {"index.json", index},
		{blobPath(target), blobs[blobPath(target)]}, {blobPath(config), blobs[blobPath(config)]},
	} {
		if err := tw.WriteHeader(&tar.Header{Name: entry.name, Mode: 0644, Size: int64(len(entry.data))}); err != nil {
			return err
		}
		if _, err := io.Copy(tw, bytes.NewReader(entry.data)); err != nil {
			return err
		}
	}
	return tw.Close()
}

func pinnedReference(name string, target ocispec.Descriptor) string {
	return strings.Split(name, "@")[0] + "@" + target.Digest.String()
}
