package parcel

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

func randomToken() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func tokenHash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func HashPassword(s string) (string, error) {
	if len(s) < 8 || len(s) > 256 {
		return "", fmt.Errorf("密码长度应为 8–256 字节")
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	key := argon2.IDKey([]byte(s), salt, 2, 32*1024, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=32768,t=2,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}
func checkPassword(s, encoded string) bool {
	if len(s) > 256 {
		return false
	}
	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[1] != "argon2id" || p[2] != "v=19" {
		return false
	}
	var m, t uint32
	var threads uint8
	if _, e := fmt.Sscanf(p[3], "m=%d,t=%d,p=%d", &m, &t, &threads); e != nil || m < 8 || m > 64*1024 || t < 1 || t > 5 || threads < 1 || threads > 4 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(p[4])
	if e != nil || len(salt) != 16 {
		return false
	}
	key, e := base64.RawStdEncoding.DecodeString(p[5])
	if e != nil || len(key) != 32 {
		return false
	}
	actual := argon2.IDKey([]byte(s), salt, t, m, threads, 32)
	return subtle.ConstantTimeCompare(actual, key) == 1
}
