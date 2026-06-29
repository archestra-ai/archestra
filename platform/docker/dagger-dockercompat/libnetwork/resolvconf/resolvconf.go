package resolvconf

import (
	"bytes"
	"net"
	"os"
	"strings"
)

const (
	defaultPath   = "/etc/resolv.conf"
	alternatePath = "/run/systemd/resolve/resolv.conf"
)

type IPVersion int

const (
	IP IPVersion = iota
	IPv4
	IPv6
)

type File struct {
	Content []byte
}

func Path() string {
	content, err := os.ReadFile(defaultPath)
	if err != nil {
		return defaultPath
	}

	nameservers := GetNameservers(content, IP)
	if len(nameservers) == 1 && nameservers[0] == "127.0.0.53" {
		return alternatePath
	}

	return defaultPath
}

func GetNameservers(content []byte, version IPVersion) []string {
	var nameservers []string

	for _, line := range lines(content) {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}

		ip := net.ParseIP(fields[1])
		if ip == nil {
			continue
		}

		if version == IPv4 && ip.To4() == nil {
			continue
		}
		if version == IPv6 && ip.To4() != nil {
			continue
		}

		nameservers = append(nameservers, fields[1])
	}

	return nameservers
}

func GetSearchDomains(content []byte) []string {
	var search []string

	for _, line := range lines(content) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		switch fields[0] {
		case "domain", "search":
			search = fields[1:]
		}
	}

	return search
}

func GetOptions(content []byte) []string {
	var options []string

	for _, line := range lines(content) {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "options" {
			continue
		}

		options = append(options, fields[1:]...)
	}

	return options
}

func Build(_ string, nameservers, search, options []string) (*File, error) {
	var buffer bytes.Buffer

	for _, nameserver := range nameservers {
		buffer.WriteString("nameserver ")
		buffer.WriteString(nameserver)
		buffer.WriteByte('\n')
	}

	if len(search) > 0 {
		buffer.WriteString("search ")
		buffer.WriteString(strings.Join(search, " "))
		buffer.WriteByte('\n')
	}

	if len(options) > 0 {
		buffer.WriteString("options ")
		buffer.WriteString(strings.Join(options, " "))
		buffer.WriteByte('\n')
	}

	return &File{Content: buffer.Bytes()}, nil
}

func FilterResolvDNS(content []byte, ipv6 bool) (*File, error) {
	var filtered []string

	for _, nameserver := range GetNameservers(content, IP) {
		ip := net.ParseIP(nameserver)
		if ip == nil || ip.IsLoopback() {
			continue
		}
		if !ipv6 && ip.To4() == nil {
			continue
		}

		filtered = append(filtered, nameserver)
	}

	if len(filtered) == 0 {
		filtered = []string{"8.8.8.8", "8.8.4.4"}
		if ipv6 {
			filtered = append(filtered, "2001:4860:4860::8888", "2001:4860:4860::8844")
		}
	}

	return Build("", filtered, GetSearchDomains(content), GetOptions(content))
}

func lines(content []byte) []string {
	var result []string

	for _, rawLine := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}

		if before, _, ok := strings.Cut(line, "#"); ok {
			line = strings.TrimSpace(before)
		}
		if before, _, ok := strings.Cut(line, ";"); ok {
			line = strings.TrimSpace(before)
		}
		if line == "" {
			continue
		}

		result = append(result, line)
	}

	return result
}
