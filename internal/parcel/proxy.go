package parcel

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// clientIP trusts X-Forwarded-For only from explicitly configured proxy peers.
// Walk from the nearest proxy towards the client: entries to the left of the
// first untrusted hop can be supplied by that client and must not be used.
// Forwarded, X-Real-IP and forwarding headers for Host/scheme are not trusted.
func (a *App) clientIP(r *http.Request) string {
	if identity, ok := r.Context().Value(gatewayIdentityKey{}).(gatewayIdentity); ok {
		return identity.ClientIP
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	if !a.trustedProxy(peer) {
		return peer.String()
	}
	raw := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
	if raw == "" || len(raw) > 4096 {
		return peer.String()
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 32 {
		return peer.String()
	}
	current := peer
	for i := len(parts) - 1; i >= 0; i-- {
		if !a.trustedProxy(current) {
			break
		}
		ip, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
		if err != nil || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() {
			return peer.String()
		}
		current = ip.Unmap()
	}
	return current.String()
}

func (a *App) trustedProxy(ip netip.Addr) bool {
	for _, prefix := range a.C.TrustedProxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
