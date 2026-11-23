package authn

import (
	"testing"
	"time"

	"github.com/companyuser/backend/config"
	"github.com/companyuser/backend/models"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func withSecret(t *testing.T, s string) {
	old := config.Cfg.JWTSecret
	config.Cfg.JWTSecret = s
	t.Cleanup(func() { config.Cfg.JWTSecret = old })
}

func TestAccessTokenRoundTrip(t *testing.T) {
	withSecret(t, "test-secret-test-secret-test-secret!")
	u := &models.AppUser{ID: uuid.New(), Email: "a@b.co"}
	tok, exp, err := IssueAccessToken(u)
	if err != nil {
		t.Fatal(err)
	}
	if time.Until(exp) < 59*time.Minute {
		t.Fatalf("unexpected expiry %v", exp)
	}
	got, err := ParseAccessToken(tok)
	if err != nil || got != u.ID {
		t.Fatalf("parse: got %v, %v", got, err)
	}
}

func TestAccessTokenRejects(t *testing.T) {
	withSecret(t, "test-secret-test-secret-test-secret!")
	u := &models.AppUser{ID: uuid.New(), Email: "a@b.co"}
	tok, _, _ := IssueAccessToken(u)

	// Different secret.
	config.Cfg.JWTSecret = "another-secret-another-secret-another"
	if _, err := ParseAccessToken(tok); err == nil {
		t.Fatal("accepted token signed with another secret")
	}
	config.Cfg.JWTSecret = "test-secret-test-secret-test-secret!"

	// Expired.
	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": u.ID.String(), "iss": issuer, "aud": audience,
		"exp": time.Now().Add(-time.Minute).Unix(),
	})
	s, _ := expired.SignedString([]byte(config.Cfg.JWTSecret))
	if _, err := ParseAccessToken(s); err == nil {
		t.Fatal("accepted expired token")
	}

	// Wrong issuer (a token from another system signed with the same secret).
	foreign := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": u.ID.String(), "iss": "someone-else", "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	s, _ = foreign.SignedString([]byte(config.Cfg.JWTSecret))
	if _, err := ParseAccessToken(s); err == nil {
		t.Fatal("accepted token from another issuer")
	}

	// alg=none.
	none := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"sub": u.ID.String(), "iss": issuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	s, _ = none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if _, err := ParseAccessToken(s); err == nil {
		t.Fatal("accepted alg=none token")
	}
}

// Hashes with the $2a$ prefix (from other bcrypt libraries) must verify as-is.
func TestBcrypt2aCompatible(t *testing.T) {
	h, _ := bcrypt.GenerateFromPassword([]byte("123456"), 10)
	h2a := "$2a$" + string(h)[4:]
	if bcrypt.CompareHashAndPassword([]byte(h2a), []byte("123456")) != nil {
		t.Fatal("$2a$ hash did not verify")
	}
}

func TestHashPasswordLength(t *testing.T) {
	if _, err := HashPassword("12345"); err != ErrWeakPassword {
		t.Fatalf("want ErrWeakPassword, got %v", err)
	}
	if _, err := HashPassword("123456"); err != nil {
		t.Fatal(err)
	}
}

func TestValidEmail(t *testing.T) {
	for e, want := range map[string]bool{
		"a@b.co": true, "user.name@x.io": true,
		"": false, "a@b": false, "@b.co": false, "a b@c.de": false, "a@": false,
	} {
		if got := validEmail(e); got != want {
			t.Errorf("validEmail(%q) = %v, want %v", e, got, want)
		}
	}
}
