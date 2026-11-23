// Package authn handles login: bcrypt passwords in app_users, HS256 access
// tokens and rotating refresh tokens.
package authn

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/companyuser/backend/config"
	"github.com/companyuser/backend/database"
	"github.com/companyuser/backend/models"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

const (
	AccessTokenTTL  = time.Hour
	RefreshTokenTTL = 30 * 24 * time.Hour
	MinPasswordLen  = 6

	issuer   = "fsid-backend"
	audience = "authenticated"
)

var (
	ErrInvalidCredentials = errors.New("invalid login credentials")
	ErrInvalidRefresh     = errors.New("invalid refresh token")
	ErrEmailTaken         = errors.New("a user with this email already exists")
	ErrWeakPassword       = fmt.Errorf("password must be at least %d characters", MinPasswordLen)
	ErrInvalidEmail       = errors.New("invalid email address")
)

// dummyHash is compared against when the email is unknown, so a login for a
// missing user takes as long as one with a wrong password.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcrypt.DefaultCost)

// NormalizeEmail trims and lower-cases an email address.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func validEmail(email string) bool {
	at := strings.LastIndex(email, "@")
	return at > 0 && at < len(email)-1 && strings.Contains(email[at:], ".") && !strings.ContainsAny(email, " \t\r\n")
}

// HashPassword bcrypt-hashes a password after checking its length.
func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLen {
		return "", ErrWeakPassword
	}
	if len(password) > 72 { // bcrypt limit
		return "", errors.New("password must be at most 72 characters")
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(h), err
}

// ── Users ────────────────────────────────────────────────────────────────────

// CreateUser inserts a login identity inside tx and returns its id.
func CreateUser(tx *gorm.DB, email, password, name string) (uuid.UUID, error) {
	email = NormalizeEmail(email)
	if !validEmail(email) {
		return uuid.Nil, ErrInvalidEmail
	}
	if taken, err := EmailTaken(tx, email, uuid.Nil); err != nil {
		return uuid.Nil, err
	} else if taken {
		return uuid.Nil, ErrEmailTaken
	}
	hash, err := HashPassword(password)
	if err != nil {
		return uuid.Nil, err
	}
	u := models.AppUser{ID: uuid.New(), Email: email, PasswordHash: hash, Name: name}
	if err := tx.Create(&u).Error; err != nil {
		return uuid.Nil, err
	}
	return u.ID, nil
}

// EmailTaken reports whether another user (not except) already uses email.
func EmailTaken(tx *gorm.DB, email string, except uuid.UUID) (bool, error) {
	var n int64
	err := tx.Model(&models.AppUser{}).
		Where("lower(email) = ? AND id <> ?", NormalizeEmail(email), except).
		Count(&n).Error
	return n > 0, err
}

// UpdateEmail changes a user's login email (kept in sync with company_users).
func UpdateEmail(tx *gorm.DB, userID uuid.UUID, email string) error {
	email = NormalizeEmail(email)
	if !validEmail(email) {
		return ErrInvalidEmail
	}
	if taken, err := EmailTaken(tx, email, userID); err != nil {
		return err
	} else if taken {
		return ErrEmailTaken
	}
	return tx.Model(&models.AppUser{}).Where("id = ?", userID).
		Updates(map[string]interface{}{"email": email, "updated_at": time.Now()}).Error
}

// SetPassword replaces a user's password and signs out all their sessions.
func SetPassword(tx *gorm.DB, userID uuid.UUID, password string) error {
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	res := tx.Model(&models.AppUser{}).Where("id = ?", userID).
		Updates(map[string]interface{}{"password_hash": hash, "updated_at": time.Now()})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return RevokeAllRefreshTokens(tx, userID)
}

// DeleteUser removes a login identity (refresh tokens cascade).
func DeleteUser(tx *gorm.DB, userID uuid.UUID) error {
	return tx.Where("id = ?", userID).Delete(&models.AppUser{}).Error
}

// CheckPassword verifies an email/password pair and returns the user.
func CheckPassword(email, password string) (*models.AppUser, error) {
	var u models.AppUser
	err := database.DB.Where("lower(email) = ?", NormalizeEmail(email)).First(&u).Error
	if err != nil {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrInvalidCredentials
		}
		return nil, err
	}
	if u.PasswordHash == "" || bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) != nil {
		return nil, ErrInvalidCredentials
	}
	return &u, nil
}

// ── Access tokens ────────────────────────────────────────────────────────────

// IssueAccessToken signs a short-lived JWT whose sub is the user's id.
func IssueAccessToken(u *models.AppUser) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(AccessTokenTTL)
	claims := jwt.MapClaims{
		"sub":   u.ID.String(),
		"email": u.Email,
		"iss":   issuer,
		"aud":   audience,
		"iat":   now.Unix(),
		"exp":   exp.Unix(),
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.Cfg.JWTSecret))
	return tok, exp, err
}

// ParseAccessToken validates a token and returns its user id.
func ParseAccessToken(tokenStr string) (uuid.UUID, error) {
	token, err := jwt.Parse(tokenStr,
		func(t *jwt.Token) (interface{}, error) { return []byte(config.Cfg.JWTSecret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
	)
	if err != nil || !token.Valid {
		return uuid.Nil, errors.New("invalid token")
	}
	sub, err := token.Claims.GetSubject()
	if err != nil {
		return uuid.Nil, errors.New("missing sub claim")
	}
	return uuid.Parse(sub)
}

// ── Refresh tokens ───────────────────────────────────────────────────────────

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// NewRefreshToken creates and stores a refresh token for userID.
func NewRefreshToken(tx *gorm.DB, userID uuid.UUID) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(b)
	rt := models.AuthRefreshToken{
		ID:        uuid.New(),
		UserID:    userID,
		TokenHash: hashToken(raw),
		ExpiresAt: time.Now().Add(RefreshTokenTTL),
	}
	if err := tx.Create(&rt).Error; err != nil {
		return "", err
	}
	return raw, nil
}

// RotateRefreshToken revokes raw and issues a replacement for the same user.
func RotateRefreshToken(raw string) (*models.AppUser, string, error) {
	var user models.AppUser
	var next string
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		// Revoke atomically so the same token can't be used twice concurrently.
		var rt models.AuthRefreshToken
		res := tx.Raw(`UPDATE auth_refresh_tokens SET revoked_at = now()
			WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now()
			RETURNING id, user_id`, hashToken(raw)).Scan(&rt)
		if res.Error != nil {
			return res.Error
		}
		if rt.UserID == uuid.Nil {
			return ErrInvalidRefresh
		}
		if err := tx.First(&user, "id = ?", rt.UserID).Error; err != nil {
			return ErrInvalidRefresh
		}
		var err error
		next, err = NewRefreshToken(tx, user.ID)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	return &user, next, nil
}

// RevokeRefreshToken signs out one session. Unknown tokens are ignored.
func RevokeRefreshToken(raw string) error {
	return database.DB.Model(&models.AuthRefreshToken{}).
		Where("token_hash = ? AND revoked_at IS NULL", hashToken(raw)).
		Update("revoked_at", time.Now()).Error
}

// RevokeAllRefreshTokens signs out every session of userID.
func RevokeAllRefreshTokens(tx *gorm.DB, userID uuid.UUID) error {
	return tx.Model(&models.AuthRefreshToken{}).
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Update("revoked_at", time.Now()).Error
}

// PruneRefreshTokens deletes expired or revoked tokens older than a day.
func PruneRefreshTokens() error {
	return database.DB.Exec(`DELETE FROM auth_refresh_tokens
		WHERE expires_at < now() OR revoked_at < now() - interval '1 day'`).Error
}
