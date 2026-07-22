package seccomp

import (
	mobyseccomp "github.com/moby/profiles/seccomp"
	"github.com/opencontainers/runtime-spec/specs-go"
)

func GetDefaultProfile(spec *specs.Spec) (*specs.LinuxSeccomp, error) {
	return mobyseccomp.GetDefaultProfile(spec)
}
