package reexec

import (
	"os/exec"

	mobyreexec "github.com/moby/sys/reexec"
)

func Register(name string, initializer func()) {
	mobyreexec.Register(name, initializer)
}

func Init() bool {
	return mobyreexec.Init()
}

func Command(args ...string) *exec.Cmd {
	return mobyreexec.Command(args...)
}

func Self() string {
	return mobyreexec.Self()
}
