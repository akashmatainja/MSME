package handlers

import (
	"errors"
	"log"
	"strings"
	"time"

	"github.com/companyuser/backend/authn"
	"github.com/companyuser/backend/database"
	"github.com/companyuser/backend/middleware"
	"github.com/companyuser/backend/models"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"gorm.io/gorm"
)

// RegisterAuthRoutes adds the public /auth endpoints. Call it before the
// JWT-protected /api/v1 group (both main.go and api/index.go use this).
func RegisterAuthRoutes(app *fiber.App) {
	g := app.Group("/auth")
	g.Post("/login", limiter.New(limiter.Config{
		Max:        10,
		Expiration: time.Minute,
		// Per client IP + email, so one shared proxy IP can't lock everyone out.
		KeyGenerator: func(c *fiber.Ctx) string {
			ip := c.IP()
			if fwd := c.Get("X-Forwarded-For"); fwd != "" {
				ip = strings.TrimSpace(strings.Split(fwd, ",")[0])
			}
			var body struct {
				Email string `json:"email"`
			}
			_ = c.BodyParser(&body)
			return ip + "|" + authn.NormalizeEmail(body.Email)
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": "Too many login attempts. Please try again later."})
		},
	}), Login)
	g.Post("/refresh", RefreshSession)
	g.Post("/logout", Logout)
}

type sessionResponse struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	ExpiresAt    int64       `json:"expires_at"` // unix seconds
	User         sessionUser `json:"user"`
}

type sessionUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func issueSession(c *fiber.Ctx, u *models.AppUser, refresh string) error {
	access, exp, err := authn.IssueAccessToken(u)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to issue token"})
	}
	return c.JSON(sessionResponse{
		AccessToken:  access,
		RefreshToken: refresh,
		ExpiresAt:    exp.Unix(),
		User:         sessionUser{ID: u.ID.String(), Email: u.Email, Name: u.Name},
	})
}

// POST /auth/login  {email, password}
func Login(c *fiber.Ctx) error {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.BodyParser(&req); err != nil || req.Email == "" || req.Password == "" {
		return c.Status(400).JSON(fiber.Map{"error": "email and password are required"})
	}

	user, err := authn.CheckPassword(req.Email, req.Password)
	if errors.Is(err, authn.ErrInvalidCredentials) {
		return c.Status(401).JSON(fiber.Map{"error": "Invalid login credentials"})
	}
	if err != nil {
		log.Printf("login: %v", err)
		return c.Status(500).JSON(fiber.Map{"error": "login failed"})
	}

	refresh, err := authn.NewRefreshToken(database.DB, user.ID)
	if err != nil {
		log.Printf("login: refresh token: %v", err)
		return c.Status(500).JSON(fiber.Map{"error": "login failed"})
	}
	database.DB.Model(user).Update("last_sign_in_at", time.Now())
	return issueSession(c, user, refresh)
}

// POST /auth/refresh  {refresh_token}
func RefreshSession(c *fiber.Ctx) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := c.BodyParser(&req); err != nil || req.RefreshToken == "" {
		return c.Status(400).JSON(fiber.Map{"error": "refresh_token is required"})
	}
	user, refresh, err := authn.RotateRefreshToken(req.RefreshToken)
	if errors.Is(err, authn.ErrInvalidRefresh) {
		return c.Status(401).JSON(fiber.Map{"error": "Invalid refresh token"})
	}
	if err != nil {
		log.Printf("refresh: %v", err)
		return c.Status(500).JSON(fiber.Map{"error": "refresh failed"})
	}
	return issueSession(c, user, refresh)
}

// POST /auth/logout  {refresh_token}
func Logout(c *fiber.Ctx) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := c.BodyParser(&req); err == nil && req.RefreshToken != "" {
		if err := authn.RevokeRefreshToken(req.RefreshToken); err != nil {
			log.Printf("logout: %v", err)
		}
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// POST /api/v1/auth/change-password
func ChangePassword(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)

	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	if len(req.NewPassword) < authn.MinPasswordLen {
		return c.Status(400).JSON(fiber.Map{"error": "New password must be at least 6 characters"})
	}
	if req.CurrentPassword == req.NewPassword {
		return c.Status(400).JSON(fiber.Map{"error": "Current password and new password must be different"})
	}

	var me models.AppUser
	if err := database.DB.First(&me, "id = ?", auth.AuthUserID).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "User not found"})
	}
	if _, err := authn.CheckPassword(me.Email, req.CurrentPassword); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Current password is incorrect"})
	}

	// Signs out every session, then hands this one a fresh session so the
	// user who changed the password stays logged in.
	var refresh string
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := authn.SetPassword(tx, me.ID, req.NewPassword); err != nil {
			return err
		}
		var err error
		refresh, err = authn.NewRefreshToken(tx, me.ID)
		return err
	})
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	return issueSession(c, &me, refresh)
}
