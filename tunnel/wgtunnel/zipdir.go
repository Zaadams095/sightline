package wgtunnel

import (
	"archive/zip"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ZipFolder packs every file under dir into a .zip at outPath, with paths inside the archive
// starting at rootName/ (e.g. "Sightline export 2026-10-11/"). Videos and photos are already
// compressed, so files are stored as-is: packing is quick and the zip is barely bigger than
// the files. Archives over 4 GB use ZIP64 automatically.
func ZipFolder(dir, outPath, rootName string) error {
	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(out)
	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || filepath.Clean(path) == filepath.Clean(outPath) {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if rootName != "" {
			name = strings.TrimSuffix(rootName, "/") + "/" + name
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = name
		hdr.Method = zip.Store
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, f)
		f.Close()
		return err
	})
	closeErr := zw.Close()
	fileErr := out.Close()
	for _, e := range []error{walkErr, closeErr, fileErr} {
		if e != nil {
			os.Remove(outPath)
			return e
		}
	}
	return nil
}
