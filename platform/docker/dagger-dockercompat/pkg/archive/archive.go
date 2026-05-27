package archive

import (
	"io"

	"github.com/docker/docker/pkg/idtools"
	mobyarchive "github.com/moby/go-archive"
	"github.com/moby/go-archive/compression"
)

type WhiteoutFormat = mobyarchive.WhiteoutFormat

type ChownOpts = mobyarchive.ChownOpts

type TarOptions struct {
	IncludeFiles           []string
	ExcludePatterns        []string
	Compression            compression.Compression
	NoLchown               bool
	IDMap                  idtools.IdentityMapping
	ChownOpts              *ChownOpts
	IncludeSourceDir       bool
	WhiteoutFormat         WhiteoutFormat
	NoOverwriteDirNonDir   bool
	RebaseNames            map[string]string
	InUserNS               bool
	BestEffortXattrs       bool
	CopyPass               bool
	IdentityMapping        idtools.IdentityMapping
	AllowUnprivilegedChown bool
}

const (
	AUFSWhiteoutFormat    = mobyarchive.AUFSWhiteoutFormat
	OverlayWhiteoutFormat = mobyarchive.OverlayWhiteoutFormat
)

func DecompressStream(archive io.Reader) (io.ReadCloser, error) {
	return compression.DecompressStream(archive)
}

func AsMobyTarOptions(options *TarOptions) *mobyarchive.TarOptions {
	if options == nil {
		return nil
	}

	return &mobyarchive.TarOptions{
		IncludeFiles:         options.IncludeFiles,
		ExcludePatterns:      options.ExcludePatterns,
		Compression:          options.Compression,
		NoLchown:             options.NoLchown,
		IDMap:                idtools.ToUserIdentityMapping(options.IDMap),
		ChownOpts:            options.ChownOpts,
		IncludeSourceDir:     options.IncludeSourceDir,
		WhiteoutFormat:       options.WhiteoutFormat,
		NoOverwriteDirNonDir: options.NoOverwriteDirNonDir,
		RebaseNames:          options.RebaseNames,
		InUserNS:             options.InUserNS,
		BestEffortXattrs:     options.BestEffortXattrs,
	}
}
