package chrootarchive

import (
	"io"

	"github.com/docker/docker/pkg/archive"
	mobychrootarchive "github.com/moby/go-archive/chrootarchive"
)

func Untar(tarArchive io.Reader, dest string, options *archive.TarOptions) error {
	return mobychrootarchive.Untar(tarArchive, dest, archive.AsMobyTarOptions(options))
}
