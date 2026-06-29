package idtools

import "github.com/moby/sys/user"

const ContainerAdministratorSidString = "S-1-5-32-544"

type IDMap = user.IDMap

type Identity struct {
	UID int
	GID int
}

type IdentityMapping struct {
	UIDMaps []IDMap `json:"UIDMaps"`
	GIDMaps []IDMap `json:"GIDMaps"`
}

func FromUserIdentityMapping(mapping user.IdentityMapping) IdentityMapping {
	return IdentityMapping{
		UIDMaps: mapping.UIDMaps,
		GIDMaps: mapping.GIDMaps,
	}
}

func (mapping IdentityMapping) Empty() bool {
	return mapping.asUserMapping().Empty()
}

func (mapping IdentityMapping) RootPair() Identity {
	uid, gid := mapping.asUserMapping().RootPair()
	return Identity{UID: uid, GID: gid}
}

func (mapping IdentityMapping) ToContainer(pair Identity) (int, int, error) {
	return mapping.asUserMapping().ToContainer(pair.UID, pair.GID)
}

func (mapping IdentityMapping) ToHost(pair Identity) (Identity, error) {
	uid, gid, err := mapping.asUserMapping().ToHost(pair.UID, pair.GID)
	return Identity{UID: uid, GID: gid}, err
}

func ToUserIdentityMapping(mapping IdentityMapping) user.IdentityMapping {
	return mapping.asUserMapping()
}

func (mapping IdentityMapping) asUserMapping() user.IdentityMapping {
	return user.IdentityMapping{
		UIDMaps: mapping.UIDMaps,
		GIDMaps: mapping.GIDMaps,
	}
}
